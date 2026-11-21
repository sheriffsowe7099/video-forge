/**
 * HTTP API server (no framework; Node http + typed routes).
 *
 * Security notes:
 * - All request bodies are validated server-side before use.
 * - Files are stored privately; media access goes through
 *   /api/projects/:id/media/* which resolves keys server-side.
 * - No secrets are returned to clients. Prompts are not logged.
 * - Single-trusted-user deployment by default (see README security section).
 * - JSON error responses include only readable messages, no stack traces.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  type Project,
  type Scene,
  planStoryboard,
  reorderScenes,
  sceneDurationsSumError,
  validateImageMime,
  validateMode,
  validateProjectSettings,
  validatePrompt,
  validateTitle,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  parseCaptionText,
  captionsToVtt,
} from '@video-forge/shared';
import { createProviderFromEnv, NodeEnv } from './providers/factory.js';
import { RenderPipeline } from './pipeline.js';
import { Storage } from './storage.js';
import { JobStore } from './jobstore.js';
import { isFFmpegAvailable } from './ffmpeg.js';

export interface ServerConfig {
  port: number;
  host: string;
  dataDir: string;
  maxUploadBytes: number;
  retentionDays: number;
  maxConcurrentJobs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    port: intOr(env.VF_PORT, 3001),
    host: env.VF_HOST || '127.0.0.1',
    dataDir: env.VF_DATA_DIR || './data',
    maxUploadBytes: intOr(env.VF_MAX_UPLOAD_BYTES, MAX_IMAGE_BYTES),
    retentionDays: intOr(env.VF_RETENTION_DAYS, 30),
    maxConcurrentJobs: intOr(env.VF_MAX_CONCURRENT_JOBS, 2),
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function bad(status: number, message: string): never {
  throw new HttpError(status, message);
}

export interface AppContext {
  config: ServerConfig;
  storage: Storage;
  jobStore: JobStore;
  pipeline: RenderPipeline;
  provider: ReturnType<typeof createProviderFromEnv>;
}

export function createApp(config: ServerConfig) {
  const storage = new Storage(config.dataDir);
  const jobStore = new JobStore(join(config.dataDir, 'state'));
  const provider = createProviderFromEnv(new NodeEnv());
  const pipeline = new RenderPipeline({ provider, storage, jobStore, concurrency: 1 });

  const server = createServer(async (req, res) => {
    try {
      await route(req, res, { config, storage, jobStore, provider, pipeline });
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error('[server] request failed:', err instanceof Error ? err.message : err);
      sendJson(res, 500, { error: 'Internal server error.' });
    }
  });

  return { server, storage, jobStore, provider, pipeline, config };
}

async function route(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const parts = url.pathname.split('/').filter((p) => p.length > 0);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const caps = await ctx.provider.capabilities();
    const ffmpeg = await isFFmpegAvailable();
    sendJson(res, 200, {
      backend: {
        id: caps.id,
        name: caps.name,
        available: caps.available,
        unavailableReason: caps.unavailableReason,
        supportedHeights: caps.supportedHeights,
        supportedClipDurations: caps.supportedClipDurations,
        supportsImageToVideo: caps.supportsImageToVideo,
        supportsSeed: caps.supportsSeed,
        supportsProgress: caps.supportsProgress,
      },
      ffmpegAvailable: ffmpeg,
      retentionDays: ctx.config.retentionDays,
      maxConcurrentJobs: ctx.config.maxConcurrentJobs,
    });
    return;
  }

  if (parts[0] !== 'api' || parts[1] !== 'projects') {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }
  await routeProjects(req, res, ctx, parts);
}

async function routeProjects(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AppContext,
  parts: string[],
): Promise<void> {
  // POST /api/projects — create project (plans storyboard)
  if (req.method === 'POST' && parts.length === 2) {
    const body = await readJson(req, 1_000_000);
    const title = validateTitle(body.title);
    if (!title.ok) bad(400, title.error!);
    const mode = validateMode(body.mode);
    if (!mode.ok) bad(400, mode.error!);
    const prompt = validatePrompt(body.prompt);
    if (!prompt.ok) bad(400, prompt.error!);
    const caps = await ctx.provider.capabilities();
    const settingsResult = validateProjectSettings(
      body.settings ?? {},
      caps.supportedHeights,
      caps.supportedClipDurations,
    );
    if (!settingsResult.ok) bad(400, settingsResult.error!);
    const settings = settingsResult.value!;

    if (mode.value === 'image-to-video' && !caps.supportsImageToVideo) {
      bad(
        400,
        'The configured backend does not support image-to-video. Use text-to-video, or configure an image-to-video backend (see README).',
      );
    }

    const project: Project = {
      id: crypto.randomUUID(),
      title: title.value!,
      mode: mode.value!,
      prompt: prompt.value!,
      settings,
      scenes: planStoryboard({ mode: mode.value!, prompt: prompt.value!, settings, referenceImageName: null }),
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      outputKey: null,
      output: null,
    };
    await ctx.jobStore.createProject(project);
    sendJson(res, 201, project);
    return;
  }

  // GET /api/projects
  if (req.method === 'GET' && parts.length === 2) {
    sendJson(res, 200, ctx.jobStore.listProjects());
    return;
  }

  const projectId = parts[2];
  if (projectId === undefined || !/^[a-zA-Z0-9-]+$/.test(projectId)) {
    bad(404, 'Project not found.');
  }
  const project = ctx.jobStore.getProject(projectId);
  if (project === undefined) {
    bad(404, 'Project not found.');
  }

  // GET /api/projects/:id
  if (req.method === 'GET' && parts.length === 3) {
    sendJson(res, 200, project);
    return;
  }

  // DELETE /api/projects/:id
  if (req.method === 'DELETE' && parts.length === 3) {
    await ctx.storage.remove(`projects/${projectId}`);
    const removed = await ctx.jobStore.deleteProject(projectId);
    sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'Project not found.' });
    return;
  }

  // POST /api/projects/:id/duplicate
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'duplicate') {
    const copy = await ctx.jobStore.duplicateProject(
      projectId,
      crypto.randomUUID(),
      `${project.title} (copy)`,
    );
    if (copy === undefined) bad(404, 'Project not found.');
    sendJson(res, 201, copy);
    return;
  }

  // PUT /api/projects/:id — update title/prompt/settings
  if (req.method === 'PUT' && parts.length === 3) {
    const body = await readJson(req, 1_000_000);
    const caps = await ctx.provider.capabilities();
    const updated = await ctx.jobStore.updateProject(projectId, (p) => {
      const next = { ...p };
      if (body.title !== undefined) {
        const title = validateTitle(body.title);
        if (!title.ok) bad(400, title.error!);
        next.title = title.value!;
      }
      if (body.settings !== undefined) {
        const result = validateProjectSettings(body.settings, caps.supportedHeights, caps.supportedClipDurations);
        if (!result.ok) bad(400, result.error!);
        next.settings = result.value!;
      }
      if (body.prompt !== undefined) {
        const prompt = validatePrompt(body.prompt);
        if (!prompt.ok) bad(400, prompt.error!);
        next.prompt = prompt.value!;
      }
      const samePlan =
        body.settings === undefined ||
        (next.settings.sceneCount === p.settings.sceneCount &&
          next.settings.totalDurationSeconds === p.settings.totalDurationSeconds &&
          next.settings.clipDurationSeconds === p.settings.clipDurationSeconds &&
          next.settings.style === p.settings.style);
      if (!samePlan) {
        next.scenes = planStoryboard({
          mode: next.mode,
          prompt: next.prompt,
          settings: next.settings,
          referenceImageName: null,
        });
      }
      return next;
    });
    if (updated === undefined) bad(404, 'Project not found.');
    sendJson(res, 200, updated);
    return;
  }

  // ---- Scene editing ----

  // PUT /api/projects/:id/scenes/:sceneId
  if (req.method === 'PUT' && parts.length === 5 && parts[3] === 'scenes') {
    const sceneId = parts[4]!;
    const body = await readJson(req, 200_000);
    const updated = await ctx.jobStore.updateProject(projectId, (p) => {
      const idx = p.scenes.findIndex((s) => s.id === sceneId);
      if (idx === -1) bad(404, 'Scene not found.');
      const next: Scene = { ...p.scenes[idx]! };
      if (body.prompt !== undefined) {
        const prompt = validatePrompt(body.prompt);
        if (!prompt.ok) bad(400, prompt.error!);
        next.prompt = prompt.value!;
      }
      if (body.durationSeconds !== undefined) {
        if (
          typeof body.durationSeconds !== 'number' ||
          !Number.isInteger(body.durationSeconds) ||
          body.durationSeconds < 1 ||
          body.durationSeconds > 20
        ) {
          bad(400, 'Scene duration must be a whole number of seconds between 1 and 20.');
        }
        next.durationSeconds = body.durationSeconds;
        next.status = 'pending';
        next.outputKey = null;
      }
      const durationError = sceneDurationsSumError(
        p.scenes.map((s) => (s.id === sceneId ? next.durationSeconds : s.durationSeconds)),
        p.settings.totalDurationSeconds,
      );
      if (durationError !== null) bad(400, durationError);
      p.scenes[idx] = next;
      return p;
    });
    if (updated === undefined) bad(404, 'Project not found.');
    sendJson(res, 200, updated);
    return;
  }

  // POST /api/projects/:id/scenes — add scene
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'scenes') {
    const body = await readJson(req, 200_000);
    const caps = await ctx.provider.capabilities();
    const updated = await ctx.jobStore.updateProject(projectId, (p) => {
      if (p.scenes.length >= 40) {
        bad(400, 'This project already has the maximum of 40 scenes.');
      }
      if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
        bad(400, 'Scene prompt is required.');
      }
      if (
        typeof body.durationSeconds !== 'number' ||
        !Number.isInteger(body.durationSeconds) ||
        body.durationSeconds < 1 ||
        !caps.supportedClipDurations.includes(body.durationSeconds)
      ) {
        bad(
          400,
          `Scene duration must be one of the backend-supported clip durations: ${caps.supportedClipDurations.join(', ')}s.`,
        );
      }
      const newTotal =
        p.scenes.reduce((a, s) => a + s.durationSeconds, 0) + body.durationSeconds;
      if (newTotal > p.settings.totalDurationSeconds) {
        bad(
          400,
          `Adding this scene would exceed the project target duration (${p.settings.totalDurationSeconds}s). Shorten other scenes or raise the target.`,
        );
      }
      p.scenes.push({
        id: crypto.randomUUID(),
        order: p.scenes.length,
        prompt: body.prompt.trim(),
        durationSeconds: body.durationSeconds,
        referenceImage: null,
        status: 'pending',
        progress: null,
        outputKey: null,
        error: '',
        attempts: 0,
      });
      return p;
    });
    if (updated === undefined) bad(404, 'Project not found.');
    sendJson(res, 201, updated);
    return;
  }

  // DELETE /api/projects/:id/scenes/:sceneId
  if (req.method === 'DELETE' && parts.length === 5 && parts[3] === 'scenes') {
    const sceneId = parts[4]!;
    const updated = await ctx.jobStore.updateProject(projectId, (p) => {
      const idx = p.scenes.findIndex((s) => s.id === sceneId);
      if (idx === -1) bad(404, 'Scene not found.');
      p.scenes.splice(idx, 1);
      p.scenes = p.scenes.map((s, i) => ({ ...s, order: i }));
      return p;
    });
    if (updated === undefined) bad(404, 'Project not found.');
    sendJson(res, 200, updated);
    return;
  }

  // POST /api/projects/:id/scenes/reorder
  if (req.method === 'POST' && parts.length === 5 && parts[3] === 'scenes' && parts[4] === 'reorder') {
    const body = await readJson(req, 200_000);
    const updated = await ctx.jobStore.updateProject(projectId, (p) => {
      if (typeof body.from !== 'number' || typeof body.to !== 'number') {
        bad(400, 'from and to must be numbers.');
      }
      p.scenes = reorderScenes(p.scenes, body.from, body.to);
      return p;
    });
    if (updated === undefined) bad(404, 'Project not found.');
    sendJson(res, 200, updated);
    return;
  }

  // POST /api/projects/:id/scenes/:sceneId/regenerate
  if (req.method === 'POST' && parts.length === 6 && parts[3] === 'scenes' && parts[5] === 'regenerate') {
    const sceneId = parts[4]!;
    if (!project.scenes.some((s) => s.id === sceneId)) {
      bad(404, 'Scene not found.');
    }
    await ctx.jobStore.updateProject(projectId, (p) => ({
      ...p,
      scenes: p.scenes.map((s) =>
        s.id === sceneId
          ? { ...s, status: 'pending', outputKey: null, error: '', progress: null }
          : s,
      ),
    }));
    const fresh = ctx.jobStore.getProject(projectId)!;
    const job = await ctx.pipeline.start(fresh);
    sendJson(res, 202, job);
    return;
  }

  // POST /api/projects/:id/start — submit render job (idempotent per active job)
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'start') {
    const active = ctx.jobStore
      .listJobsForProject(projectId)
      .filter((j) => j.status === 'queued' || j.status === 'running');
    if (active.length > 0) {
      bad(
        409,
        'A render job is already active for this project. Wait for it to finish or cancel it first (duplicate submissions are blocked).',
      );
    }
    const job = await ctx.pipeline.start(project);
    sendJson(res, 202, job);
    return;
  }

  // GET /api/projects/:id/jobs
  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'jobs') {
    sendJson(res, 200, ctx.jobStore.listJobsForProject(projectId));
    return;
  }

  // POST /api/projects/:id/cancel
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'cancel') {
    const jobs = ctx.jobStore
      .listJobsForProject(projectId)
      .filter((j) => j.status === 'queued' || j.status === 'running');
    if (jobs.length === 0) {
      sendJson(res, 200, { ok: false, message: 'No active job to cancel.' });
      return;
    }
    for (const j of jobs) {
      await ctx.pipeline.cancel(j.id);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /api/projects/:id/output — final video preview/download
  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'output') {
    if (project.outputKey === null) {
      bad(404, 'This project has no output yet.');
    }
    const buffer = await ctx.storage.read(project.outputKey);
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': String(buffer.byteLength),
      'content-disposition': `inline; filename="${project.output?.fileName ?? 'video.mp4'}"`,
    });
    res.end(buffer);
    return;
  }

  // GET /api/projects/:id/captions.vtt
  if (req.method === 'GET' && parts.length === 4 && parts[3] === 'captions.vtt') {
    const lines = parseCaptionText(project.settings.captions.text);
    const vtt = captionsToVtt(lines, project.scenes.map((s) => s.durationSeconds));
    res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8' });
    res.end(vtt);
    return;
  }

  // POST /api/projects/:id/upload/image — reference image upload (server-side validation)
  if (req.method === 'POST' && parts.length === 5 && parts[3] === 'upload' && parts[4] === 'image') {
    const contentType = req.headers['content-type'] ?? '';
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(contentType)) {
      bad(415, `Unsupported image type. Allowed: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}.`);
    }
    const declaredSize = Number(req.headers['content-length'] ?? '0');
    if (declaredSize > ctx.config.maxUploadBytes) {
      bad(
        413,
        `Image exceeds the upload limit (${Math.floor(ctx.config.maxUploadBytes / 1024 / 1024)} MiB).`,
      );
    }
    const bytes = await readBody(req, ctx.config.maxUploadBytes);
    const check = validateImageMime(contentType, bytes.length);
    if (!check.ok) bad(400, check.error!);
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : 'webp';
    const key = `projects/${projectId}/uploads/ref-${crypto.randomUUID()}.${ext}`;
    await ctx.storage.write(key, bytes);
    sendJson(res, 201, { storageKey: key, mimeType: contentType, sizeBytes: bytes.length });
    return;
  }

  // GET /api/projects/:id/media/:key — private media access (project-scoped)
  if (req.method === 'GET' && parts.length === 5 && parts[3] === 'media') {
    const key = decodeURIComponent(parts[4]!);
    if (!key.startsWith(`projects/${projectId}/`)) {
      bad(403, 'Forbidden: media belongs to another project.');
    }
    const buffer = await ctx.storage.read(key);
    res.writeHead(200, {
      'content-type': mimeFor(key),
      'content-length': String(buffer.byteLength),
    });
    res.end(buffer);
    return;
  }

  bad(404, 'Unknown endpoint.');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(json);
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const bytes = await readBody(req, limit);
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  } catch {
    bad(400, 'Request body must be valid JSON.');
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > limit) {
        reject(new HttpError(413, 'Request body exceeds the size limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function mimeFor(key: string): string {
  if (key.endsWith('.mp4')) return 'video/mp4';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  if (key.endsWith('.mp3') || key.endsWith('.wav') || key.endsWith('.ogg') || key.endsWith('.flac')) {
    return 'audio/mpeg';
  }
  return 'application/octet-stream';
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
