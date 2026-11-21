/**
 * Durable job store.
 *
 * A simple JSON-file-backed store appropriate for a single self-hosted
 * instance (no external database required). Writes are atomic
 * (temp file + rename) so a crash mid-write cannot corrupt the store.
 *
 * Job lifecycle is explicit and testable:
 *   queued -> running -> succeeded | failed | canceled
 * with cancelRequested as a cooperative flag checked by workers.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Project, RenderJob } from '@video-forge/shared';

export class JobStore {
  private readonly dir: string;
  private data: { projects: Project[]; jobs: RenderJob[] } = { projects: [], jobs: [] };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(join(this.dir, 'store.json'), 'utf8');
      const parsed = JSON.parse(raw) as { projects?: Project[]; jobs?: RenderJob[] };
      this.data = {
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
      };
    } catch {
      // Missing or corrupt store starts fresh; projects are not fabricated.
      this.data = { projects: [], jobs: [] };
    }
  }

  /** Serialize writes so concurrent mutations never interleave. */
  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      const tmp = join(this.dir, `store-${process.pid}-${Date.now()}.tmp`);
      await mkdir(dirname(tmp), { recursive: true });
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(tmp, join(this.dir, 'store.json'));
    };
    this.writeChain = this.writeChain.then(write, write);
    return this.writeChain;
  }

  private projectPathRoot(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error('Invalid project id.');
    }
    return this.dir;
  }

  // ----- Projects -----

  listProjects(): Project[] {
    return [...this.data.projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  getProject(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id);
  }

  async createProject(project: Project): Promise<void> {
    this.data.projects.push(project);
    await this.persist();
  }

  async updateProject(id: string, mutate: (p: Project) => Project): Promise<Project | undefined> {
    const idx = this.data.projects.findIndex((p) => p.id === id);
    if (idx === -1) {
      return undefined;
    }
    const updated = mutate(this.data.projects[idx]!);
    updated.updatedAt = new Date().toISOString();
    this.data.projects[idx] = updated;
    await this.persist();
    return updated;
  }

  async deleteProject(id: string): Promise<boolean> {
    const before = this.data.projects.length;
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    this.data.jobs = this.data.jobs.filter((j) => j.projectId !== id);
    if (this.data.projects.length === before) {
      return false;
    }
    await this.persist();
    return true;
  }

  async duplicateProject(id: string, newId: string, newTitle: string): Promise<Project | undefined> {
    const source = this.getProject(id);
    if (source === undefined) {
      return undefined;
    }
    const copy: Project = {
      ...structuredClone(source),
      id: newId,
      title: newTitle,
      status: 'draft',
      outputKey: null,
      output: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Scenes are duplicated as pending: outputs are not copied; a duplicate
    // must be regenerated rather than pretending outputs exist.
    copy.scenes = copy.scenes.map((s) => ({
      ...s,
      status: s.status === 'succeeded' ? 'pending' : s.status,
      outputKey: null,
      progress: null,
      error: '',
    }));
    await this.createProject(copy);
    return copy;
  }

  // ----- Jobs -----

  listJobsForProject(projectId: string): RenderJob[] {
    return this.data.jobs.filter((j) => j.projectId === projectId);
  }

  getJob(jobId: string): RenderJob | undefined {
    return this.data.jobs.find((j) => j.id === jobId);
  }

  async createJob(job: RenderJob): Promise<void> {
    this.data.jobs.push(job);
    await this.persist();
  }

  async updateJob(id: string, mutate: (j: RenderJob) => RenderJob): Promise<RenderJob | undefined> {
    const idx = this.data.jobs.findIndex((j) => j.id === id);
    if (idx === -1) {
      return undefined;
    }
    const updated = mutate(this.data.jobs[idx]!);
    this.data.jobs[idx] = updated;
    await this.persist();
    return updated;
  }

  /** Mark a job cancelRequested. Worker checks it between scenes. */
  async requestCancel(jobId: string): Promise<RenderJob | undefined> {
    return this.updateJob(jobId, (j) => ({
      ...j,
      cancelRequested: true,
    }));
  }

  dirPath(): string {
    return this.dir;
  }
}

// Re-export for path helpers used elsewhere.
export { join, sep } from 'node:path';
