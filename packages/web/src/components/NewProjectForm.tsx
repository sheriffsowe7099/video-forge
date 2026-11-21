import { useState } from 'react';
import type { Project, GenerationMode, ProjectSettings } from '@video-forge/shared';
import { api, type BackendHealth } from '../api';

interface Props {
  health: BackendHealth | null;
  onCreated: (id: string) => void;
}

const DURATION_MIN = 5;
const DURATION_MAX = 300;
const SCENE_MIN = 1;
const SCENE_MAX = 40;

export function NewProjectForm({ health, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<GenerationMode>('text-to-video');
  const [prompt, setPrompt] = useState('');
  const [totalDuration, setTotalDuration] = useState(24);
  const [aspectRatio, setAspectRatio] = useState<ProjectSettings['aspectRatio']>('16:9');
  const [outputHeight, setOutputHeight] = useState(768);
  const [sceneCount, setSceneCount] = useState(4);
  const [clipDuration, setClipDuration] = useState(6);
  const [style, setStyle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const supportedHeights = health?.backend.supportedHeights ?? [512, 640, 768];
  const supportedClips = health?.backend.supportedClipDurations ?? [4, 6, 8];
  const backendAvailable = health?.backend.available === true;
  const imageSupported = health?.backend.supportsImageToVideo === true;

  const effectiveHeight = supportedHeights.includes(outputHeight)
    ? outputHeight
    : (supportedHeights[0] ?? 768);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return; // Prevent double submission.
    setSubmitting(true);
    setError(null);
    try {
      const project = await api.createProject({
        title: title.trim() === '' ? 'Untitled video' : title,
        mode,
        prompt,
        settings: {
          totalDurationSeconds: totalDuration,
          aspectRatio,
          outputHeight: effectiveHeight,
          style,
          sceneCount,
          clipDurationSeconds: clipDuration,
          seed: null,
          negativePrompt: '',
          transition: 'cut',
          captions: { text: '', burnIn: false, exportSidecar: false },
          audio: {
            muted: false,
            masterVolume: 1,
            musicVolume: 0.5,
            musicFadeIn: 0,
            musicFadeOut: 2,
            musicKey: null,
          },
        },
      });
      onCreated(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card" aria-labelledby="new-video-heading">
      <h2 id="new-video-heading">New video</h2>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="np-title">Title</label>
            <input
              id="np-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="My video"
              maxLength={120}
            />
          </div>
          <div className="field">
            <label htmlFor="np-mode">Mode</label>
            <select
              id="np-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as GenerationMode)}
            >
              <option value="text-to-video">Text-to-video</option>
              <option value="image-to-video" disabled={!imageSupported}>
                Image-to-video {imageSupported ? '' : '(backend does not support it)'}
              </option>
            </select>
          </div>
        </div>

        <div className="field">
          <label htmlFor="np-prompt">Prompt</label>
          <textarea
            id="np-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the video. The planner will split this into scenes you can edit."
            required
          />
          <p className="hint">
            The storyboard planner is heuristic (it segments your text; it is not a language model). Every
            scene prompt is fully editable before generation.
          </p>
        </div>

        <div className="grid-2">
          <div className="field">
            <label htmlFor="np-duration">Total duration (seconds, 5–300)</label>
            <input
              id="np-duration"
              type="number"
              min={DURATION_MIN}
              max={DURATION_MAX}
              step={1}
              value={totalDuration}
              onChange={(e) => setTotalDuration(Number(e.target.value))}
              required
            />
            <p className="hint">
              Videos up to 5 minutes are assembled from multiple short clips — no model generates a
              continuous 5-minute scene in one operation.
            </p>
          </div>
          <div className="field">
            <label htmlFor="np-scenes">Scenes</label>
            <input
              id="np-scenes"
              type="number"
              min={SCENE_MIN}
              max={SCENE_MAX}
              step={1}
              value={sceneCount}
              onChange={(e) => setSceneCount(Number(e.target.value))}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="np-aspect">Aspect ratio</label>
            <select
              id="np-aspect"
              value={aspectRatio}
              onChange={(e) => setAspectRatio(e.target.value as ProjectSettings['aspectRatio'])}
            >
              <option value="16:9">16:9 (landscape)</option>
              <option value="9:16">9:16 (portrait)</option>
              <option value="1:1">1:1 (square)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="np-clip">Clip duration (backend capability)</label>
            <select
              id="np-clip"
              value={clipDuration}
              onChange={(e) => setClipDuration(Number(e.target.value))}
            >
              {supportedClips.map((d) => (
                <option key={d} value={d}>
                  {d}s
                </option>
              ))}
            </select>
            <p className="hint">Only durations your configured backend supports are offered.</p>
          </div>
          <div className="field">
            <label htmlFor="np-height">Output resolution</label>
            <select
              id="np-height"
              value={effectiveHeight}
              onChange={(e) => setOutputHeight(Number(e.target.value))}
            >
              {supportedHeights.map((h) => (
                <option key={h} value={h}>
                  {h}p
                </option>
              ))}
            </select>
            <p className="hint">Only resolutions your backend supports are listed.</p>
          </div>
          <div className="field">
            <label htmlFor="np-style">Style direction (optional)</label>
            <input
              id="np-style"
              type="text"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              placeholder="e.g. watercolor, warm colors"
              maxLength={200}
            />
          </div>
        </div>

        <div className="notice info">
          Generation runs on your own self-hosted backend and requires your own GPU/compute. Nothing is sent
          to any external service.{' '}
          {!backendAvailable && 'Right now no backend is configured — you can prepare the storyboard, but generation will be refused.'}
        </div>

        {error !== null && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn" disabled={submitting || prompt.trim() === ''}>
          {submitting ? 'Creating…' : 'Create storyboard'}
        </button>
      </form>
    </section>
  );
}
