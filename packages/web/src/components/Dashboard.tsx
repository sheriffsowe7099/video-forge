import type { Project } from '@video-forge/shared';
import type { BackendHealth } from '../api.js';
import { NewProjectForm } from './NewProjectForm.jsx';

interface Props {
  health: BackendHealth | null;
  projects: Project[] | null;
  projectsError: string | null;
  onOpen: (id: string) => void;
  onRefreshProjects: () => Promise<void>;
  onRefreshHealth: () => Promise<void>;
}

export function Dashboard({ health, projects, projectsError, onOpen, onRefreshProjects, onRefreshHealth }: Props) {
  return (
    <>
      <NewProjectForm health={health} onCreated={onOpen} />

      <section className="card" aria-labelledby="recent-heading">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 id="recent-heading">Recent projects</h2>
          <div>
            <button type="button" className="btn secondary" onClick={() => void onRefreshProjects()}>
              Refresh projects
            </button>
            <button type="button" className="btn secondary" onClick={() => void onRefreshHealth()}>
              Refresh backend
            </button>
          </div>
        </div>

        {projectsError !== null && (
          <p className="error-text" role="alert">
            {projectsError}
          </p>
        )}

        {projects === null && projectsError === null && <p>Loading projects…</p>}

        {projects !== null && projects.length === 0 && (
          <div className="empty-state">
            <h2>No projects yet</h2>
            <p>Create your first video above. Projects appear here with their status.</p>
          </div>
        )}

        {projects !== null &&
          projects.map((p) => (
            <div className="project-list-item" key={p.id}>
              <div>
                <button type="button" className="btn secondary" onClick={() => onOpen(p.id)}>
                  {p.title}
                </button>
                <p className="hint">
                  {p.mode} · {p.settings.totalDurationSeconds}s · {p.scenes.length} scenes ·{' '}
                  <span className={`scene-status ${p.status}`}>{p.status}</span>
                </p>
              </div>
              <span className={`scene-status ${p.status}`}>{p.status}</span>
            </div>
          ))}
      </section>
    </>
  );
}
