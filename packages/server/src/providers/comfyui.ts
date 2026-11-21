/**
 * ComfyUI provider.
 *
 * Adapter for a self-hosted ComfyUI instance (https://github.com/comfyanonymous/ComfyUI)
 * exposing its HTTP API on localhost. Model-specific workflow JSON is
 * NOT hard-coded here: the user supplies a workflow template file per
 * mode (see README) whose LoadCheckpoint/CLIPTextEncode nodes receive
 * the prompt, and whose image nodes receive the reference image.
 *
 * The provider reads the workflow from disk, patches prompt/dimension
 * fields, queues it, polls history, and downloads the resulting video
 * file. Failures map to honest ProviderError kinds.
 *
 * This is a best-effort adapter: ComfyUI workflow graphs vary wildly
 * by model. Read the README section "Connecting ComfyUI" before use.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type GenerationProvider,
  type GenerateRequest,
  type GenerateProgressEvent,
  type ProviderCapabilities,
  ProviderError,
} from './provider.js';

/** Default ComfyUI API surface (no trailing slash). */
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // generous: diffusion is slow

export interface ComfyUIProviderOptions {
  /** Base URL of the ComfyUI HTTP API, e.g. http://127.0.0.1:8188 */
  baseUrl: string;
  /** Path to a workflow template JSON file for text-to-video. */
  textWorkflowPath: string;
  /** Path to a workflow template JSON for image-to-video (optional). */
  imageWorkflowPath: string | null;
  /** Node ids inside the workflow that receive the prompt. */
  promptNodeId: string;
  /** Node id that receives the negative prompt (optional). */
  negativeNodeId: string | null;
  /** Node id that receives width/height (optional). */
  dimensionNodeId: string | null;
  /** Node id that receives the seed (optional). */
  seedNodeId: string | null;
  /** Node id that receives the uploaded reference image (image-to-video). */
  imageNodeId: string | null;
  /** Node id whose output is the video (for history lookup). */
  outputNodeId: string;
}

interface ComfyHistoryEntry {
  status?: { completed?: boolean; status_str?: string };
  outputs?: Record<string, { videos?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
}

export class ComfyUIProvider implements GenerationProvider {
  private readonly opts: ComfyUIProviderOptions;

  constructor(opts: ComfyUIProviderOptions) {
    this.opts = opts;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    try {
      const res = await fetch(`${this.opts.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return this.unavailable(`ComfyUI responded with HTTP ${res.status} at ${this.opts.baseUrl}. Check that ComfyUI is running.`);
      }
    } catch (err) {
      return this.unavailable(
        `Cannot reach ComfyUI at ${this.opts.baseUrl} (${describeError(err)}). Start ComfyUI and verify the URL (VF_COMFY_URL).`,
      );
    }
    return {
      id: 'comfyui',
      name: 'ComfyUI (self-hosted)',
      available: true,
      unavailableReason: null,
      // These are enforced by app validation: the workflow must be able
      // to produce these; the user asserts them via env config. The UI
      // shows them as "configured values", not detected facts.
      supportedHeights: [512, 640, 768],
      supportedClipDurations: [4, 6, 8],
      supportsImageToVideo: this.opts.imageWorkflowPath !== null && this.opts.imageNodeId !== null,
      supportsSeed: this.opts.seedNodeId !== null,
      supportsProgress: false, // ComfyUI history has no fractional progress
    };
  }

  private unavailable(reason: string): ProviderCapabilities {
    return {
      id: 'comfyui',
      name: 'ComfyUI (self-hosted)',
      available: false,
      unavailableReason: reason,
      supportedHeights: [512, 640, 768],
      supportedClipDurations: [4, 6, 8],
      supportsImageToVideo: this.opts.imageWorkflowPath !== null && this.opts.imageNodeId !== null,
      supportsSeed: this.opts.seedNodeId !== null,
      supportsProgress: false,
    };
  }

  async generate(
    request: GenerateRequest,
    onProgress: (event: GenerateProgressEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const usingImage = request.referenceImagePath !== null;
    const workflowPath = usingImage ? this.opts.imageWorkflowPath : this.opts.textWorkflowPath;
    if (workflowPath === null) {
      throw new ProviderError(
        'invalid-input',
        usingImage
          ? 'Image-to-video is not configured for this backend (VF_COMFY_IMAGE_WORKFLOW and VF_COMFY_IMAGE_NODE are not set). Text-to-video is available.'
          : 'No text-to-video workflow is configured (VF_COMFY_TEXT_WORKFLOW is not set).',
      );
    }

    // Load workflow template.
    let workflowText: string;
    try {
      workflowText = await Bun.file(workflowPath).text();
    } catch {
      try {
        workflowText = (await import('node:fs/promises')).readFile(workflowPath, 'utf8');
      } catch {
        throw new ProviderError('invalid-input', `Cannot read workflow template at ${workflowPath}. Fix the VF_COMFY_*_WORKFLOW path.`);
      }
    }

    let workflow: Record<string, unknown>;
    try {
      workflow = JSON.parse(workflowText) as Record<string, unknown>;
    } catch {
      throw new ProviderError('invalid-input', `Workflow template at ${workflowPath} is not valid JSON.`);
    }

    // Upload reference image first (image-to-video).
    let uploadName: string | null = null;
    if (usingImage && this.opts.imageNodeId !== null) {
      uploadName = await this.uploadImage(request.referenceImagePath!, signal);
      const imageNode = (workflow as Record<string, Record<string, unknown>>)[this.opts.imageNodeId];
      if (imageNode !== undefined) {
        imageNode.inputs = {
          ...(imageNode.inputs as Record<string, unknown>),
          image: uploadName,
        };
      }
    }

    // Patch prompt fields.
    const patch = (nodeId: string | null, key: string, value: unknown): void => {
      if (nodeId === null) return;
      const nodes = workflow as Record<string, Record<string, unknown>>;
      const node = nodes[nodeId];
      if (node === undefined) return;
      const inputs = (node.inputs ?? {}) as Record<string, unknown>;
      inputs[key] = value;
      node.inputs = inputs;
    };
    patch(this.opts.promptNodeId, 'text', request.prompt);
    if (this.opts.negativeNodeId !== null) {
      patch(this.opts.negativeNodeId, 'text', request.negativePrompt);
    }
    const { width, height } = dimensionsFor(request.height, request.aspectRatio);
    if (this.opts.dimensionNodeId !== null) {
      patch(this.opts.dimensionNodeId, 'width', width);
      patch(this.opts.dimensionNodeId, 'height', height);
    }
    if (request.seed !== null && this.opts.seedNodeId !== null) {
      patch(this.opts.seedNodeId, 'seed', request.seed);
    }

    // Queue the prompt and poll history until complete.
    const queueRes = await fetch(`${this.opts.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
      signal,
    }).catch((err: unknown) => {
      throw new ProviderError('unavailable', `Cannot reach ComfyUI at ${this.opts.baseUrl}: ${describeError(err)}`);
    });
    if (!queueRes.ok) {
      const body = await queueRes.text().catch(() => '');
      if (queueRes.status === 503 && body.includes('out of memory')) {
        throw new ProviderError('out-of-memory', 'ComfyUI reported an out-of-memory error. Lower the resolution or scene count, or use a smaller model/quantization.');
      }
      throw new ProviderError(
        'invalid-input',
        `ComfyUI rejected the workflow (HTTP ${queueRes.status}). Check node ids in your VF_COMFY_* env config. ${truncate(body)}`,
      );
    }
    const queued = (await queueRes.json().catch(() => null)) as { prompt_id?: string } | null;
    const promptId = queued?.prompt_id;
    if (typeof promptId !== 'string' || promptId.length === 0) {
      throw new ProviderError('server-error', 'ComfyUI did not return a prompt id.');
    }

    onProgress({ progress: null }); // heartbeat: generation started, indeterminate

    const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal.aborted) {
        throw new ProviderError('unavailable', 'Generation canceled.');
      }
      await sleep(2000);
      let history: ComfyHistoryEntry | null = null;
      try {
        const histRes = await fetch(`${this.opts.baseUrl}/history/${promptId}`, { signal });
        if (histRes.ok) {
          const body = (await histRes.json()) as Record<string, ComfyHistoryEntry>;
          history = body[promptId] ?? null;
        }
      } catch (err) {
        if (signal.aborted) throw new ProviderError('unavailable', 'Generation canceled.');
        throw new ProviderError('unavailable', `Lost connection to ComfyUI while generating: ${describeError(err)}`);
      }
      if (history === null) continue;
      const status = history.status?.status_str;
      if (status === 'error') {
        throw new ProviderError('server-error', 'ComfyUI reported an execution error for this scene. Check the ComfyUI server console for details.');
      }
      const outputs = history.outputs ?? {};
      const outputEntry = outputs[this.opts.outputNodeId];
      const video = outputEntry?.videos?.[0];
      if (video !== undefined) {
        await this.downloadVideo(video, request.outputClipPath, signal);
        return;
      }
    }
    throw new ProviderError('timeout', 'Generation timed out after 20 minutes for this scene. The backend may be overloaded or the model too slow for this clip length.');
  }

  private async uploadImage(imagePath: string, signal: AbortSignal): Promise<string> {
    let bytes: ArrayBuffer;
    try {
      bytes = await Bun.file(imagePath).arrayBuffer();
    } catch {
      try {
        bytes = (await (await import('node:fs/promises')).readFile(imagePath)).buffer;
      } catch {
        throw new ProviderError('invalid-input', 'Cannot read the uploaded reference image from storage.');
      }
    }
    const name = basename(imagePath);
    const form = new FormData();
    form.append('image', new Blob([bytes]), name);
    const res = await fetch(`${this.opts.baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
      signal,
    }).catch((err: unknown) => {
      throw new ProviderError('unavailable', `Cannot upload reference image to ComfyUI: ${describeError(err)}`);
    });
    if (!res.ok) {
      throw new ProviderError('server-error', `ComfyUI image upload failed (HTTP ${res.status}).`);
    }
    const body = (await res.json().catch(() => null)) as { name?: string } | null;
    if (typeof body?.name !== 'string' || body.name.length === 0) {
      throw new ProviderError('server-error', 'ComfyUI did not confirm the image upload.');
    }
    return body.name;
  }

  private async downloadVideo(
    video: { filename: string; subfolder?: string; type?: string },
    outputClipPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const params = new URLSearchParams({ filename: video.filename });
    if (video.subfolder !== undefined) params.set('subfolder', video.subfolder);
    if (video.type !== undefined) params.set('type', video.type);
    const res = await fetch(`${this.opts.baseUrl}/view?${params.toString()}`, {
      signal,
    }).catch((err: unknown) => {
      throw new ProviderError('unavailable', `Cannot download the generated clip from ComfyUI: ${describeError(err)}`);
    });
    if (!res.ok) {
      throw new ProviderError('server-error', `Clip download failed (HTTP ${res.status}).`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new ProviderError('server-error', 'ComfyUI returned an empty clip file.');
    }
    await mkdir(dirname(outputClipPath), { recursive: true });
    await writeFile(outputClipPath, buffer);
  }
}

function dimensionsFor(height: number, aspectRatio: '16:9' | '9:16' | '1:1'): { width: number; height: number } {
  switch (aspectRatio)) {
    case '16:9':
      return { width: roundEven((height * 16) / 9), height: roundEven(height) };
    case '9:16':
      return { width: roundEven(height), height: roundEven((height * 16) / 9) };
    case '1:1':
    default:
      return { width: roundEven(height), height: roundEven(height) };
  }
}

function roundEven(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r + 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 200 ? `${err.message.slice(0, 200)}...` : err.message;
  }
  return 'unknown error';
}

function truncate(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '.' : p.slice(0, idx);
}
