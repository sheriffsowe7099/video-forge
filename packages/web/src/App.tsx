import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@video-forge/shared';
import { api, type BackendHealth } from './api';
import { Dashboard } from './components/Dashboard';
import { ProjectEditor } from './components/ProjectEditor';
import { Settings } from './components/Settings';

type View = { kind: 'dashboard' } | { kind: 'project'; id: string } | { kind: 'settings' };

export function App() {
  const [view, setView] = useState<View>({ kind: 'dashboard' });
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
      setHealthError(null);
    } catch (err) {
      setHealth(null);
      setHealthError(err instanceof Error ? err.message : 'Cannot reach the VideoForge server.');
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
      setProjectsError(null);
    } catch (err) {
      setProjects(null);
      setProjectsError(err instanceof Error ? err.message : 'Cannot load projects.');
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    void refreshProjects();
  }, [refreshHealth, refreshProjects]);

  return (
    <>
      <header className="app-header">
        <h1>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setView({ kind: 'dashboard' })}
            aria-label="Go to dashboard"
          >
            VideoForge
          </button>
        </h1>
        <nav>
          <ul className="inline-list">
            <li>
              <button type="button" className="btn secondary" onClick={() => setView({ kind: 'dashboard' })}>
                Dashboard
              </button>
            </li>
            <li>
              <button type="button" className="btn secondary" onClick={() => setView({ kind: 'settings' })}>
                Backend status
              </button>
            </li>
          </ul>
        </nav>
        {health !== null ? (
          <span className={health.backend.available ? 'badge ok' : 'badge bad'}>
            {health.backend.available ? `Backend: ${health.backend.name}` : 'Backend not configured'}
          </span>
        ) : (
          <span className="badge warn">{healthError !== null ? 'Server unreachable' : 'Checking…'}</span>
        )}
      </header>

      <main className="container" role="main">
        {health !== null && !health.backend.available && (
          <div className="notice">
            <strong>Generation backend not configured.</strong> You can create and edit projects, but videos
            cannot be generated until you connect a self-hosted backend (see the “Backend status” page or the
            repository README). Nothing is fabricated while the backend is unavailable.
          </div>
        )}

        {view.kind === 'dashboard' && (
          <Dashboard
            health={health}
            projects={projects}
            projectsError={projectsError}
            onOpen={(id) => setView({ kind: 'project', id })}
            onRefreshProjects={refreshProjects}
            onRefreshHealth={refreshHealth}
          />
        )}

        {view.kind === 'project' && (
          <ProjectEditor
            projectId={view.id}
            health={health}
            onBack={() => {
              void refreshProjects();
              setView({ kind: 'dashboard' });
            }}
          />
        )}

        {view.kind === 'settings' && (
          <Settings health={health} healthError={healthError} onRefresh={refreshHealth} />
        )}
      </main>
    </>
  );
}
