import { api, type BackendHealth } from '../api';

interface Props {
  health: BackendHealth | null;
  healthError: string | null;
  onRefresh: () => Promise<void>;
}

export function Settings({ health, healthError, onRefresh }: Props) {
  return (
    <section className="card" aria-labelledby="backend-heading">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h2 id="backend-heading">Backend status</h2>
        <button type="button" className="btn secondary" onClick={() => void onRefresh()}>
          Re-check now
        </button>
      </div>

      {healthError !== null && (
        <div className="notice danger">
          <strong>Cannot reach the VideoForge server.</strong> Check that the server is running
          ({healthError}).
        </div>
      )}

      {health === null && healthError === null && <p>Checking backend…</p>}

      {health !== null && (
        <>
          <div className="notice">
            <strong>Generation backend:</strong>{' '}
            {health.backend.available ? (
              <span className="badge ok">Configured and reachable — {health.backend.name}</span>
            ) : (
              <span className="badge bad">Not available</span>
            )}
          </div>
          {!health.backend.available && health.backend.unavailableReason !== null && (
            <p className="error-text">{health.backend.unavailableReason}</p>
          )}

          <h3>Capabilities</h3>
          <div className="meta-grid">
            <div>
              <strong>{health.backend.supportedHeights.join(', ') || '—'}</strong>
              output heights (px)
            </div>
            <div>
              <strong>{health.backend.supportedClipDurations.join(', ')}s</strong>
              supported clip durations
            </div>
            <div>
              <strong>{health.backend.supportsImageToVideo ? 'Yes' : 'No'}</strong>
              image-to-video support
            </div>
            <div>
              <strong>{health.backend.supportsSeed ? 'Yes' : 'No'}</strong>
              reproducible seed support
            </div>
            <div>
              <strong>{health.backend.supportsProgress ? 'Yes (percentages)' : 'No (indeterminate spinner shown instead)'}</strong>
              progress reporting
            </div>
            <div>
              <strong>{health.ffmpegAvailable ? 'Installed' : 'Missing — install FFmpeg'}</strong>
              FFmpeg (required for assembly)
            </div>
            <div>
              <strong>{health.retentionDays} days</strong>
              project data retention
            </div>
            <div>
              <strong>{health.maxConcurrentJobs}</strong>
              max concurrent render jobs
            </div>
          </div>

          <h3>How to connect a backend</h3>
          <p className="hint">
            VideoForge generates video only through a self-hosted backend you configure — for example
            ComfyUI with an open-source video model. Set <code>VF_PROVIDER=comfyui</code> and the{' '}
            <code>VF_COMFY_*</code> variables in the server environment, then restart the server. See the
            repository README (“Connecting a generation backend”) for step-by-step instructions. No paid
            API is involved; you provide the hardware.
          </p>
        </>
      )}
    </section>
  );
}
