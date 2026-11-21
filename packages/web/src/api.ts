/** API client. All calls go to the same origin (proxied in dev). */

import type { Project, RenderJob, Scene, ProjectSettings, GenerationMode } from '@video-forge/shared';

export interface BackendHealth {
  backend: {
    id: string;
    name: string;
    available: boolean;
    unavailableReason: string | null;
    supportedHeights: number[];
    supportedClipDurations: number[];
    supportsImageToVideo: boolean;
    supportsSeed: boolean;
    supportsProgress: boolean;
  };
  ffmpegAvailable: boolean;
  retentionDays: number;
  maxConcurrentJobs: number;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `Request failed (HTTP ${res.status}).`;
    try {
      const data = (await res.json()) as { error?: string };
      if (typeof data.error === 'string') {
        message = data.error;
      }
    } catch {
      // keep default message
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  health(): Promise<BackendHealth> {
    return request<BackendHealth>('GET', '/api/health');
  },
  listProjects(): Promise<Project[]> {
    return request<Project[]>('GET', '/api/projects');
  },
  getProject(id: string): Promise<Project> {
    return request<Project>('GET', `/api/projects/${id}`);
  },
  createProject(input: {
    title: string;
    mode: GenerationMode;
    prompt: string;
    settings: ProjectSettings;
  }): Promise<Project> {
    return request<Project>('POST', '/api/projects', input);
  },
  updateProject(id: string, body: Partial<Pick<Project, 'title' | 'prompt' | 'settings'>>): Promise<Project> {
    return request<Project>('PUT', `/api/projects/${id}`, body);
  },
  deleteProject(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('DELETE', `/api/projects/${id}`);
  },
  duplicateProject(id: string): Promise<Project> {
    return request<Project>('POST', `/api/projects/${id}/duplicate`);
  },
  updateScene(projectId: string, sceneId: string, body: { prompt?: string; durationSeconds?: number }): Promise<Project> {
    return request<Project>('PUT', `/api/projects/${projectId}/scenes/${sceneId}`, body);
  },
  addScene(projectId: string, body: { prompt: string; durationSeconds: number }): Promise<Project> {
    return request<Project>('POST', `/api/projects/${projectId}/scenes`, body);
  },
  deleteScene(projectId: string, sceneId: string): Promise<Project> {
    return request<Project>('DELETE', `/api/projects/${projectId}/scenes/${sceneId}`);
  },
  reorderScenes(projectId: string, from: number, to: number): Promise<Project> {
    return request<Project>('POST', `/api/projects/${projectId}/scenes/reorder`, { from, to });
  },
  regenerateScene(projectId: string, sceneId: string): Promise<RenderJob> {
    return request<RenderJob>('POST', `/api/projects/${projectId}/scenes/${sceneId}/regenerate`);
  },
  startRender(projectId: string): Promise<RenderJob> {
    return request<RenderJob>('POST', `/api/projects/${projectId}/start`);
  },
  cancelRender(projectId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('POST', `/api/projects/${projectId}/cancel`);
  },
  listJobs(projectId: string): Promise<RenderJob[]> {
    return request<RenderJob[]>('GET', `/api/projects/${projectId}/jobs`);
  },
  uploadImage(projectId: string, file: File): Promise<{ storageKey: string; mimeType: string; sizeBytes: number }> {
    return fetch(`/api/projects/${projectId}/upload/image`, {
      method: 'POST',
      headers: { 'content-type': file.type },
      body: file,
    }).then(async (res) => {
      if (!res.ok) {
        let message = `Upload failed (HTTP ${res.status}).`;
        try {
          const data = (await res.json()) as { error?: string };
          if (typeof data.error === 'string') message = data.error;
        } catch {
          // keep default
        }
        throw new ApiError(res.status, message);
      }
      return (await res.json()) as { storageKey: string; mimeType: string; sizeBytes: number };
    });
  },
};
