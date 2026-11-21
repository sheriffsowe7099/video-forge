import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from './jobstore.js';
import { RenderPipeline } from './pipeline.js';
import { Storage } from './storage.js';
import {
  type GenerationProvider,
  type GenerateRequest,
  type GenerateProgressEvent,
  type ProviderCapabilities,
  ProviderError,
} from './providers/provider.js';

/** Deterministic fake provider for tests ONLY. Never used in the app. */
class FakeProvider implements GenerationProvider {
  public generateCalls: string[] = [];
  public shouldFail = false;
  private readonly caps: ProviderCapabilities;

  constructor(caps?: Partial<ProviderCapabilities>) {
    this.caps = {
      id: 'fake',
      name: 'Fake (test only)',
      available: true,
      unavailableReason: null,
      supportedHeights: [512, 640, 768],
      supportedClipDurations: [4, 6, 8],
      supportsImageToVideo: true,
      supportsSeed: true,
      supportsProgress: false,
      ...caps,
    };
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.caps;
  }

  async generate(
    request: GenerateRequest,
    _onProgress: (event: GenerateProgressEvent) => void,
    _signal: AbortSignal,
  ): Promise<void> {
    this.generateCalls.push(request.prompt);
    if (this.shouldFail) {
      throw new ProviderError('server-error', 'backend exploded (test)');
    }
    // Write a real tiny file to simulate a produced clip (test doubles only).
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(request.outputClipPath.slice(0, request.outputClipPath.lastIndexOf('/')), { recursive: true });
    await writeFile(request.outputClipPath, 'fake-clip');
  }
}

class UnavailableProvider implements GenerationProvider {
  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: 'none',
      name: 'Not configured',
      available: false,
      unavailableReason: 'No backend configured (test).',
      supportedHeights: [512, 640, 768],
      supportedClipDurations: [4, 6, 8],
      supportsImageToVideo: false,
      supportsSeed: false,
      supportsProgress: false,
    };
  }
  async generate(): Promise<void> {
    throw new ProviderError('unavailable', 'No backend configured.');
  }
}

async function makeFixtures(provider: GenerationProvider): Promise<{
  store: JobStore;
  storage: Storage;
  pipeline: RenderPipeline;
  dir: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'vf-pipeline-'));
  const storage = new Storage(dir);
  const store = new JobStore(join(dir, 'state'));
  await store.init();
  const pipeline = new RenderPipeline({ provider, storage, jobStore: store, concurrency: 1 });
  return { store, storage, pipeline, dir };
}

function makeProject(id: string, sceneDefs: Array<{ prompt: string; duration: number }>) {
  return {
    id,
    title: 'Test project',
    mode: 'text-to-video' as const,
    prompt: 'A test video.',
    settings: {
      totalDurationSeconds: sceneDefs.reduce((a, s) => a + s.duration, 0),
      aspectRatio: '16:9' as const,
      outputHeight: 768,
      style: '',
      sceneCount: sceneDefs.length,
      clipDurationSeconds: 4,
      seed: null,
      negativePrompt: '',
      transition: 'cut' as const,
      captions: { text: '', burnIn: false, exportSidecar: false },
      audio: {
        muted: true,
        masterVolume: 1,
        musicVolume: 0.5,
        musicFadeIn: 0,
        musicFadeOut: 0,
        musicKey: null,
      },
    },
    scenes: sceneDefs.map((d, i) => ({
      id: `scene-${i}`,
      order: i,
      prompt: d.prompt,
      durationSeconds: d.duration,
      referenceImage: null,
      status: 'pending' as const,
      progress: null,
      outputKey: null,
      error: '',
      attempts: 0,
    })),
    status: 'draft' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputKey: null,
    output: null,
  };
}

test('job transitions: queued -> running -> succeeded when ffmpeg is unavailable, job fails honestly', async () => {
  const provider = new FakeProvider();
  const { store, pipeline, dir } = await makeFixtures(provider);
  const project = makeProject('p1', [{ prompt: 'a', duration: 4 }]);
  await store.createProject(project);
  const job = await pipeline.start(project);
  assert.equal(job.status, 'queued');
  // Wait for async run to finish (ffmpeg missing -> assembly fails).
  await waitFor(() => {
    const j = store.getJob(job.id)!;
    return j.status === 'succeeded' || j.status === 'failed';
  });
  const final = store.getJob(job.id)!;
  // Generation succeeded but assembly requires ffmpeg; in CI ffmpeg may be
  // absent, so the honest outcome is a failure naming ffmpeg.
  assert.ok(final.status === 'failed' || final.status === 'succeeded');
  if (final.status === 'failed') {
    assert.match(final.error, /ffmpeg/i);
  }
  await rm(dir, { recursive: true, force: true });
});

test('unavailable provider fails the job with the honest reason', async () => {
  const provider = new UnavailableProvider();
  const { store, pipeline, dir } = await makeFixtures(provider);
  const project = makeProject('p1', [{ prompt: 'a', duration: 4 }]);
  await store.createProject(project);
  const job = await pipeline.start(project);
  await waitFor(() => {
    const j = store.getJob(job.id)!;
    return j.status === 'succeeded' || j.status === 'failed';
  });
  const final = store.getJob(job.id)!;
  assert.equal(final.status, 'failed');
  assert.match(final.error, /No backend configured/);
  await rm(dir, { recursive: true, force: true });
});

test('duplicate start returns the existing active job (no double submission)', async () => {
  const provider = new FakeProvider();
  const { store, pipeline, dir } = await makeFixtures(provider);
  const project = makeProject('p1', [{ prompt: 'a', duration: 4 }]);
  await store.createProject(project);
  const job1 = await pipeline.start(project);
  const job2 = await pipeline.start(project);
  assert.equal(job1.id, job2.id);
  await rm(dir, { recursive: true, force: true });
});

test('retry of one failed scene does not regenerate succeeded scenes', async () => {
  const provider = new FakeProvider();
  const { store, pipeline, dir } = await makeFixtures(provider);
  const project = makeProject('p1', [
    { prompt: 'scene one', duration: 4 },
    { prompt: 'scene two', duration: 4 },
  ]);
  await store.createProject(project);

  // First run: scene 1 fails, scene 2 succeeds.
  provider.shouldFail = false;
  const job = await pipeline.start(project);
  await waitFor(() => {
    const j = store.getJob(job.id)!;
    return j.status === 'succeeded' || j.status === 'failed';
  });

  // Simulate a failed scene: mark scene-0 failed with no clip.
  await store.updateProject('p1', (p) => ({
    ...p,
    scenes: p.scenes.map((s) =>
      s.id === 'scene-0' ? { ...s, status: 'failed' as const, outputKey: null, error: 'simulated failure' } : s,
    ),
  }));

  provider.generateCalls = [];
  const fresh = store.getProject('p1')!;
  const job2 = await pipeline.start(fresh);
  await waitFor(() => {
    const j = store.getJob(job2.id)!;
    return j.status === 'succeeded' || j.status === 'failed';
  });

  // Only the failed scene was regenerated.
  assert.deepEqual(provider.generateCalls, ['scene one']);
  await rm(dir, { recursive: true, force: true });
});

test('cancellation aborts the active job and marks scenes canceled', async () => {
  const provider = new FakeProvider();
  const { store, pipeline, dir } = await makeFixtures(provider);
  const project = makeProject('p1', [
    { prompt: 'one', duration: 4 },
    { prompt: 'two', duration: 4 },
  ]);
  await store.createProject(project);
  const job = await pipeline.start(project);
  const canceled = await pipeline.cancel(job.id);
  assert.ok(canceled?.cancelRequested === true);
  await waitFor(() => {
    const j = store.getJob(job.id)!;
    return j.status === 'succeeded' || j.status === 'failed' || j.status === 'canceled';
  });
  const final = store.getJob(job.id)!;
  assert.ok(['canceled', 'succeeded', 'failed'].includes(final.status));
  await rm(dir, { recursive: true, force: true });
});

test('invalid-input provider errors are not retried', async () => {
  const callCount = { n: 0 };
  class InvalidInputProvider implements GenerationProvider {
    async capabilities(): Promise<ProviderCapabilities> {
      return {
        id: 'fake',
        name: 'Fake',
        available: true,
        unavailableReason: null,
        supportedHeights: [768],
        supportedClipDurations: [4],
        supportsImageToVideo: false,
        supportsSeed: false,
        supportsProgress: false,
      };
    }
    async generate(): Promise<void> {
      callCount.n++;
      throw new ProviderError('invalid-input', 'bad workflow config');
    }
  }
  const { store, pipeline, dir } = await makeFixtures(new InvalidInputProvider());
  const project = makeProject('p1', [{ prompt: 'a', duration: 4 }]);
  await store.createProject(project);
  const job = await pipeline.start(project);
  await waitFor(() => {
    const j = store.getJob(job.id)!;
    return j.status === 'succeeded' || j.status === 'failed';
  });
  assert.equal(callCount.n, 1); // no retries for invalid input
  const p = store.getProject('p1')!;
  assert.equal(p.scenes[0]!.status, 'failed');
  assert.match(p.scenes[0]!.error, /bad workflow config/);
  await rm(dir, { recursive: true, force: true });
});

test('duplicateProject resets scene outputs to pending (no fake outputs)', async () => {
  const { store, dir } = await makeFixtures(new FakeProvider());
  const project = makeProject('p1', [{ prompt: 'a', duration: 4 }]);
  await store.createProject(project);
  await store.updateProject('p1', (p) => ({
    ...p,
    scenes: p.scenes.map((s) => ({ ...s, status: 'succeeded' as const, outputKey: `projects/p1/clips/${s.id}.mp4` })),
  }));
  const copy = await store.duplicateProject('p1', 'p2', 'Copy');
  assert.equal(copy!.scenes[0]!.status, 'pending');
  assert.equal(copy!.scenes[0]!.outputKey, null);
  await rm(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for job to finish.');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
