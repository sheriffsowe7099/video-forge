import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, ApiError } from './api';

describe('api client error handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('throws ApiError with the server error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: 'Prompt is required.' }),
      }),
    );
    await expect(api.createProject({ title: '', mode: 'text-to-video', prompt: '', settings: {} as never })).rejects.toThrow(
      ApiError,
    );
    await expect(
      api.createProject({ title: '', mode: 'text-to-video', prompt: '', settings: {} as never }),
    ).rejects.toThrow('Prompt is required.');
  });

  it('falls back to a generic message when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      }),
    );
    await expect(api.listProjects()).rejects.toThrow('Request failed (HTTP 500).');
  });

  it('returns parsed JSON on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ id: 'p1' }]),
      }),
    );
    const projects = await api.listProjects();
    expect(projects).toEqual([{ id: 'p1' }]);
  });
});
