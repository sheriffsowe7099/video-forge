import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, RenderJob, Scene } from '@video-forge/shared';
import { api, type BackendHealth } from '../api.js';

interface Props {
  projectId: string;
  health: BackendHealth | null;
  onBack: () => void;
}

export function ProjectEditor({ projectId, health, onBack }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setProject(await api.getProject(projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cannot load the project.');
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while generating/assembling for honest status updates.
  useEffect(() => {
    const active = project?.status === 'generating' || project?.status === 'assembling';
    if (active && pollRef.current === null) {
      pollRef.current = setInterval(() => void refresh(), 2000);
    } else if (!active && pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [project?.status, refresh]);

  async function withBusy(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  if (error !== null) {
    return (
      <section className="card">
        <p className="error-text" role="alert">{error}</p>
        <button type="button" className="btn secondary" onClick={onBack}>
          Back to dashboard
        </button>
      </section>
    );
  }

  if (project === null) {
    return <p>Loading project…</p>;
  }

  const jobActive = project.status === 'generating' || project.status === 'assembling';
  const backendAvailable = health?.backend.available === true;
  const totalPlanned = project.scenes.reduce((a, s) => a + s.durationSeconds, 0);
  const durationMatches = totalPlanned === project.settings.totalDurationSeconds;

  return (
    <>
      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <h2>{project.title}</h2>
          <div className="scene-actions">
            <button type="button" className="btn secondary" onClick={onBack}>Back</button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => void withBusy(async () => {
                const copy = await api.duplicateProject(project.id);
                onBack();
                void copy;
              })}
            >
              Duplicate
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy}
              onClick={() => void withBusy(async () => {
                await api.deleteProject(project.id);
                onBack();
              })}
            >
              Delete
            </button>
          </div>
        </div>
        <p className="hint">
          {project.mode} · target {project.settings.totalDurationSeconds}s · {project.scenes.length} scenes ·{' '}
          planned {totalPlanned}s{' '}
          {durationMatches ? '✓' : <span className="error-text">✗ (scene durations must sum to the target)</span>}
        </p>
        <p className="hint">
          Mode: {project.mode === 'image-to-video' ? 'image + prompt → video' : 'prompt → video'}
        </p>
      </section>

      {actionError !== null && (
        <div className="notice danger" role="alert">
          {actionError}
        </div>
      )}

      {!backendAvailable && (
        <div className="notice">
          The generation backend is not configured. You can edit the storyboard, but starting generation
          will return an honest error until a backend is connected (see the Backend status page).
        </div>
      )}

      <section className="card" aria-labelledby="storyboard-heading">
        <h2 id="storyboard-heading">Storyboard</h2>
        <p className="hint">
          Long videos are assembled from these shorter scenes. Edit prompts and durations; scenes must
          total the target duration. Successful scenes are kept when you retry failed ones.
        </p>

        {project.scenes.map((scene, index) => (
          <SceneRow
            key={scene.id}
            scene={scene}
            index={index}
            projectId={project.id}
            busy={busy || jobActive}
            onAction={withBusy}
          />
        ))}
      </section>

      <section className="card" aria-labelledby="render-heading">
        <h2 id="render-heading">Generate</h2>
        <div className="scene-actions">
          <button
            type="button"
            className="btn"
            disabled={busy || jobActive || !durationMatches}
            title={!backendAvailable ? 'Backend not configured' : undefined}
            onClick={() => void withBusy(async () => {
              await api.startRender(project.id);
            })}
          >
            {jobActive ? 'Generating…' : 'Start generation'}
          </button>
          {jobActive && (
            <button
              type="button"
              className="btn danger"
              onClick={() => void withBusy(async () => {
                await api.cancelRender(project.id);
              })}
            >
              Cancel
            </button>
          )}
        </div>
        {jobActive && (
          <div className="indeterminate-bar" role="status" aria-label="Generation in progress">
            <span className="sr-only">Generating scenes. Progress is indeterminate until scenes complete.</span>
          </div>
        )}
        {!health?.backend.supportsProgress && backendAvailable && jobActive && (
          <p className="hint">
            This backend does not report fractional progress, so an indeterminate indicator is shown rather
            than an invented percentage. Each scene updates as it finishes.
          </p>
        )}
      </section>

      {project.status === 'completed' && project.output !== null && (
        <section className="card" aria-labelledby="preview-heading">
          <h2 id="preview-heading">Result</h2>
          <video className="preview" controls preload="metadata" src={`/api/projects/${project.id}/output`} />
          <div className="meta-grid" style={{ marginTop: '0.75rem' }}>
            <div><strong>{project.output.format}</strong>format</div>
            <div><strong>{project.output.codec}</strong>codec</div>
            <div><strong>{project.output.width}×{project.output.height}</strong>resolution</div>
            <div><strong>{project.output.durationSeconds}s</strong>duration</div>
            <div><strong>{(project.output.sizeBytes / 1024 / 1024).toFixed(1)} MB</strong>size</div>
          </div>
          <div className="scene-actions" style={{ marginTop: '0.75rem' }}>
            <a className="btn" href={`/api/projects/${project.id}/output`} download>
              Download MP4
            </a>
            <a className="btn secondary" href={`/api/projects/${project.id}/captions.vtt`} download>
              Download captions (VTT)
            </a>
          </div>
          <p className="hint">Generated on your backend and assembled locally with FFmpeg. Nothing here is simulated.</p>
        </section>
      )}

      {project.status === 'failed' && (
        <div className="notice danger">
          Generation failed. Open the storyboard above, fix or retry the failed scenes, then start again.
          Successful scenes are preserved.
        </div>
      )}
    </>
  );
}

interface SceneRowProps {
  scene: Scene;
  index: number;
  projectId: string;
  busy: boolean;
  onAction: (action: () => Promise<void>) => Promise<void>;
}

function SceneRow({ scene, index, projectId, busy, onAction }: SceneRowProps) {
  const [prompt, setPrompt] = useState(scene.prompt);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setPrompt(scene.prompt);
  }, [scene.prompt]);

  return (
    <article className="scene-row" aria-label={`Scene ${index + 1}`}>
      <div className="scene-main">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <strong>Scene {index + 1}</strong>
          <span className={`scene-status ${scene.status}`}>{scene.status}</span>
          <span className="hint">{scene.durationSeconds}s</span>
          {scene.attempts > 0 && <span className="hint">attempt {scene.attempts}</span>}
        </div>
        {editing ? (
          <div className="field" style={{ marginTop: '0.5rem' }}>
            <label htmlFor={`scene-prompt-${scene.id}`}>Prompt</label>
            <textarea
              id={`scene-prompt-${scene.id}`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="scene-actions" style={{ marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void onAction(async () => {
                  await api.updateScene(projectId, scene.id, { prompt });
                  setEditing(false);
                })}
              >
                Save
              </button>
              <button type="button" className="btn secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p style={{ margin: '0.5rem 0' }}>{scene.prompt}</p>
        )}

        {scene.status === 'failed' && scene.error !== '' && (
          <p className="error-text" role="alert">
            {scene.error}{' '}
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => void onAction(async () => {
                await api.regenerateScene(projectId, scene.id);
              })}
            >
              Retry this scene
            </button>
          </p>
        )}
        {scene.status === 'succeeded' && scene.outputKey !== null && (
          <p className="hint">
            Clip generated.{' '}
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => void onAction(async () => {
                await api.regenerateScene(projectId, scene.id);
              })}
            >
              Regenerate
            </button>
          </p>
        )}
      </div>

      <div className="scene-actions">
        {!editing && (
          <button type="button" className="btn secondary" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          onClick={() => void onAction(async () => {
            await api.reorderScenes(projectId, index, Math.max(0, index - 1));
          })}
        >
          ↑ Up
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          onClick={() => void onAction(async () => {
            await api.reorderScenes(projectId, index, index + 1);
          })}
        >
          ↓ Down
        </button>
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={() => void onAction(async () => {
            await api.deleteScene(projectId, scene.id);
          })}
        >
          Remove
        </button>
      </div>
    </article>
  );
}
