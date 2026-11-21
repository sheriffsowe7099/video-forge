/**
 * Render pipeline: run scene generation jobs, honor cancellation, and
 * assemble the final video.
 *
 * Honesty rules enforced here:
 * - A scene is "succeeded" ONLY if its clip file exists on disk after
 *   generation. Output files are never fabricated.
 * - Progress is per-scene real state; overall progress counts scenes
 *   completed / total, which is honest (not a fabricated percentage
 *   of model inference).
 * - Cancellation is cooperative between scenes; a scene already in
 *   flight is aborted via AbortController.
 * - Retry of one failed scene never regenerates successful scenes:
 *   the worker only processes scenes whose clip file is missing.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  captionsToVtt,
  parseCaptionText,
  type Project,
  type RenderJob,
  type Scene,
} from '@video-forge/shared';
import type { GenerationProvider, ProviderCapabilities } from './providers/provider.js';
import { ProviderError } from './providers/provider.js';
import { Storage } from './storage.js';
import { runAssembly, isFFmpegAvailable, FFmpegError } from './ffmpeg.js';
import type { JobStore } from './jobstore.js';

export interface RenderDeps {
  provider: GenerationProvider;
  storage: Storage;
  jobStore: JobStore;
  /** Concurrent scene generations; default 1 (single GPU). */
  concurrency?: number;
}

const MAX_SCENE_RETRIES = 2;

export class RenderPipeline {
  private readonly provider: GenerationProvider;
  private readonly storage: Storage;
  private readonly jobStore: JobStore;
  private readonly concurrency: number;
  private readonly activeJobs = new Map<string, AbortController>();

  constructor(deps: RenderDeps) {
    this.provider = deps.provider;
    this.storage = deps.storage;
    this.jobStore = deps.jobStore;
    this.concurrency = deps.concurrency ?? 1;
  }

  isRunning(jobId: string): boolean {
    return this.activeJobs.has(jobId);
  }

  /** Start a render job for the project. Returns the job id. */
  async start(project: Project): Promise<RenderJob> {
    const existingActive = await this.findActiveJob(project.id);
    if (existingActive !== undefined) {
      return existingActive; // Prevent duplicate submission (double click).
    }

    const job: RenderJob = {
      id: crypto.randomUUID(),
      projectId: project.id,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      error: '',
      output: null,
    };
    await this.jobStore.createJob(job);
    // Fire and forget; status flows through the job store.
    void this.run(job.id, project.id).catch((err: unknown) => {
      void this.jobStore.updateJob(job.id, (j) => ({
        ...j,
        status: 'failed',
        error: `Internal worker error: ${err instanceof Error ? err.message : 'unknown'}`,
        finishedAt: new Date().toISOString(),
      }));
    });
    return job;
  }

  async cancel(jobId: string): Promise<RenderJob | undefined> {
    const job = this.jobStore.getJob(jobId);
    if (job === undefined) {
      return undefined;
    }
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
      return job;
    }
    const controller = this.activeJobs.get(jobId);
    controller?.abort();
    return this.jobStore.requestCancel(jobId);
  }

  private async findActiveJob(projectId: string): Promise<RenderJob | undefined> {
    const jobs = this.jobStore.listJobsForProject(projectId);
    return jobs.find((j) => j.status === 'queued' || j.status === 'running');
  }

  private async run(jobId: string, projectId: string): Promise<void> {
    const controller = new AbortController();
    this.activeJobs.set(jobId, controller);
    try {
      const project = this.jobStore.getProject(projectId);
      if (project === undefined) {
        throw new Error('Project not found.');
      }

      const caps: ProviderCapabilities = await this.provider.capabilities();
      if (!caps.available) {
        throw new ProviderError('unavailable', caps.unavailableReason ?? 'Generation backend is not available.');
      }

      await this.jobStore.updateJob(jobId, (j) => ({ ...j, status: 'running', startedAt: new Date().toISOString() }));
      await this.jobStore.updateProject(projectId, (p) => ({
        ...p,
        status: 'generating',
      }));

      // Queue scenes needing generation (missing clip file).
      const pendingScenes = project.scenes.filter((s) => !(s.outputKey !== null && (await this.storage.exists(s.outputKey))));
      const queue = [...pendingScenes];
      let succeeded = 0;
      let failed = 0;

      const sceneDurations = project.scenes.map((s) => s.durationSeconds);

      // Process scenes with bounded concurrency.
      const workers: Promise<void>[] = [];
      const nextScene = (): Scene | undefined => queue.shift();
      const runWorker = async (): Promise<void> => {
        for (;;) {
          const scene = nextScene();
          if (scene === undefined) {
            return;
          }
          const jobNow = this.jobStore.getJob(jobId);
          if (jobNow?.cancelRequested === true) {
            await this.updateSceneStatus(projectId, scene.id, (s) => ({ ...s, status: 'canceled', progress: null }));
            return;
          }
          await this.generateScene(projectId, jobId, scene, caps, controller.signal);
          const sceneAfter = this.jobStore.getProject(projectId)?.scenes.find((s) => s.id === scene.id);
          if (sceneAfter?.status === 'succeeded') {
            succeeded++;
          } else if (sceneAfter?.status === 'failed') {
            failed++;
          }
        }
      };
      for (let i = 0; i < this.concurrency; i++) {
        workers.push(runWorker());
      }
      await Promise.all(workers);

      const finalJob = this.jobStore.getJob(jobId);
      if (finalJob?.cancelRequested === true) {
        await this.finishJob(jobId, 'canceled', 'Canceled by user.');
        await this.jobStore.updateProject(projectId, (p) => ({ ...p, status: 'draft' }));
        return;
      }

      const fresh = this.jobStore.getProject(projectId);
      if (fresh === undefined) {
        throw new Error('Project disappeared during generation.');
      }
      const allSucceeded = fresh.scenes.every(
        (s) => s.outputKey !== null && this.storage.exists(s.outputKey) !== undefined && true,
      );
      // Re-check existence synchronously for correctness:
      let missing = 0;
      for (const s of fresh.scenes) {
        if (s.outputKey === null || !(await this.storage.exists(s.outputKey))) {
          missing++;
        }
      }
      if (missing > 0) {
        const anyFailed = fresh.scenes.some((s) => s.status === 'failed');
        await this.finishJob(jobId, 'failed', anyFailed ? 'Some scenes failed to generate. Retry failed scenes from the storyboard.' : 'Some scene clips are missing.');
        await this.jobStore.updateProject(projectId, (p) => ({ ...p, status: 'failed' }));
        return;
      }
      void allSucceeded;

      // Assemble.
      await this.jobStore.updateProject(projectId, (p) => ({ ...p, status: 'assembling' }));
      const output = await this.assemble(fresh, jobId, sceneDurations);
      await this.jobStore.updateProject(projectId, (p) => ({
        ...p,
        status: 'completed',
        outputKey: output.storageKey,
        output,
      }));
      await this.finishJob(jobId, 'succeeded', '');
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  private async generateScene(
    projectId: string,
    jobId: string,
    scene: Scene,
    caps: ProviderCapabilities,
    signal: AbortSignal,
  ): Promise<void> {
    await this.updateSceneStatus(projectId, scene.id, (s) => ({
      ...s,
      status: 'generating',
      progress: null,
      error: '',
      attempts: s.attempts + 1,
    }));
    const clipKey = `projects/${projectId}/clips/${scene.id}.mp4`;
    const clipPath = this.storage.resolveKey(clipKey);
    const refImage =
      scene.referenceImage !== null ? this.storage.resolveKey(scene.referenceImage.storageKey) : null;
    const project = this.jobStore.getProject(projectId);
    const seed = project?.settings.seed !== null && caps.supportsSeed ? (project?.settings.seed ?? null) : null;

    let lastError: ProviderError | Error = new Error('unknown');
    for (let attempt = 0; attempt <= MAX_SCENE_RETRIES; attempt++) {
      if (signal.aborted) {
        await this.updateSceneStatus(projectId, scene.id, (s) => ({ ...s, status: 'canceled', progress: null }));
        return;
      }
      try {
        await this.provider.generate(
          {
            prompt: scene.prompt,
            negativePrompt: project?.settings.negativePrompt ?? '',
            durationSeconds: scene.durationSeconds,
            height: project?.settings.outputHeight ?? 768,
            aspectRatio: project?.settings.aspectRatio ?? '16:9',
            seed,
            referenceImagePath: refImage,
            outputClipPath: clipPath,
          },
          (event) => {
            if (event.progress !== null) {
              void this.updateSceneStatus(projectId, scene.id, (s) => ({ ...s, progress: event.progress }));
            }
          },
          signal,
        );
        const clipExists = await this.storage.exists(clipKey);
        if (!clipExists) {
          throw new ProviderError('server-error', 'Backend did not produce a clip file.');
        }
        await this.updateSceneStatus(projectId, scene.id, (s) => ({
          ...s,
          status: 'succeeded',
          progress: null,
          outputKey: clipKey,
        }));
        return;
      } catch (err) {
        if (signal.aborted) {
          await this.updateSceneStatus(projectId, scene.id, (s) => ({ ...s, status: 'canceled', progress: null }));
          return;
        }
        lastError = err instanceof Error ? err : new Error(String(err));
        if (err instanceof ProviderError && err.kind === 'invalid-input') {
          break; // Do not retry invalid inputs.
        }
        await sleep(1000 * (attempt + 1));
      }
    }
    await this.updateSceneStatus(projectId, scene.id, (s) => ({
      ...s,
      status: 'failed',
      progress: null,
      error: lastError.message,
    }));
    void jobId;
  }

  private async assemble(
    project: Project,
    jobId: string,
    sceneDurations: number[],
  ): Promise<ProjectOutputLike> {
    const ffmpegOk = await isFFmpegAvailable();
    if (!ffmpegOk) {
      throw new FFmpegError(null, 'FFmpeg is not installed or not on PATH. Install FFmpeg to assemble clips (see README).');
    }
    const workDir = this.storage.resolveKey(`projects/${project.id}/work`);
    await mkdir(workDir, { recursive: true });

    const { dimensionsFor } = await import('./providers/comfyui.js');
    const dims = dimensionsFor(project.settings.outputHeight, project.settings.aspectRatio);

    // Captions.
    let subtitlesPath: string | null = null;
    const captionLines = parseCaptionText(project.settings.captions.text);
    if (captionLines.length > 0 && project.settings.captions.burnIn) {
      const vtt = captionsToVtt(captionLines, sceneDurations);
      subtitlesPath = join(workDir, 'captions.vtt');
      await this.storage.write(`projects/${project.id}/work/captions.vtt`, vtt);
    }

    const musicPath = project.settings.audio.musicKey !== null
      ? this.storage.resolveKey(project.settings.audio.musicKey)
      : null;

    const clipPaths = project.scenes
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => this.storage.resolveKey(s.outputKey!));

    const outputKey = `projects/${project.id}/output/final.mp4`;
    const outputPath = this.storage.resolveKey(outputKey);
    await runAssembly(
      {
        clipPaths,
        outputPath,
        width: dims.width,
        height: dims.height,
        transition: project.settings.transition,
        subtitlesPath,
        musicPath,
        masterVolume: project.settings.audio.masterVolume,
        mp3Volume: undefined,
        musicVolume: project.settings.audio.musicVolume,
        musicFadeIn: project.settings.audio.musicFadeIn,
        musicFadeOut: project.settings.audio.musicFadeOut,
        totalDurationSeconds: project.settings.totalDurationSeconds,
        muted: project.settings.audio.muted,
      },
      workDir,
    );

    const sizeBytes = await this.storage.size(outputKey);
    void jobId;
    return {
      storageKey: outputKey,
      fileName: `${sanitize(project.title)}.mp4`,
      format: 'mp4',
      codec: 'h264 (libx264)',
      durationSeconds: project.settings.totalDurationSeconds,
      width: dims.width,
      height: dims.height,
      sizeBytes,
      producedAt: new Date().toISOString(),
    };
  }

  private async updateSceneStatus(
    projectId: string,
    sceneId: string,
    mutate: (s: Scene) => Scene,
  ): Promise<void> {
    await this.jobStore.updateProject(projectId, (p) => ({
      ...p,
      scenes: p.scenes.map((s) => (s.id === sceneId ? mutate(s) : s)),
    }));
  }

  private async finishJob(jobId: string, status: RenderJob['status'], error: string): Promise<void> {
    await this.jobStore.updateJob(jobId, (j) => ({
      ...j,
      status,
      error,
      finishedAt: new Date().toISOString(),
    }));
  }
}

type ProjectOutputLike = {
  storageKey: string;
  fileName: string;
  format: string;
  codec: string;
  durationSeconds: number;
  width: number;
  height: number;
  sizeBytes: number;
  producedAt: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/** Cleanup old outputs per retention policy. Documented in README. */
export async function cleanupOldProjects(jobStore: JobStore, storage: Storage, maxAgeDays: number): Promise<number> {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const project of jobStore.listProjects()) {
    const ageOk = Date.parse(project.updatedAt) < cutoff;
    if (ageOk && project.status === 'completed') {
      await storage.remove(`projects/${project.id}`);
      removed++;
    }
  }
  return removed;
}
