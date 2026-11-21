/**
 * Generation provider interface.
 *
 * A provider is an adapter around a self-hosted generation backend
 * (e.g. ComfyUI or a Diffusers-based HTTP service). Model-specific
 * logic lives entirely behind this interface so another open-source
 * backend can be added without touching the UI, routes, or job store.
 *
 * Providers must be honest:
 * - `capabilities()` reports what the backend actually supports,
 *   derived from its health/config, not from wishful thinking.
 * - `generate()` either returns a real clip produced by the backend, or
 *   throws a ProviderError with a readable message. Never fabricate a
 *   file, a URL, or progress.
 */

export interface ProviderCapabilities {
  /** Provider id, e.g. "comfyui". */
  id: string;
  /** Human-readable name for the UI. */
  name: string;
  /** Whether the backend is configured and reachable right now. */
  available: boolean;
  /** Readable reason when not available (shown in the UI). */
  unavailableReason: string | null;
  /** Output heights in px supported by the backend. */
  supportedHeights: number[];
  /** Clip durations in seconds supported by the backend. */
  supportedClipDurations: number[];
  /** Whether the backend supports image conditioning (image-to-video). */
  supportsImageToVideo: boolean;
  /** Whether the backend supports reproducible seeds. */
  supportsSeed: boolean;
  /** Whether the backend reports incremental progress (else indeterminate). */
  supportsProgress: boolean;
}

export interface GenerateRequest {
  /** Scene prompt (already includes style/camera text). */
  prompt: string;
  /** Negative prompt or empty string. */
  negativePrompt: string;
  /** Requested duration in seconds; must be in supportedClipDurations. */
  durationSeconds: number;
  /** Requested output height in px; must be in supportedHeights. */
  height: number;
  /** Aspect ratio for width derivation. */
  aspectRatio: '16:9' | '9:16' | '1:1';
  /** Seed or null when not used/unsupported. */
  seed: number | null;
  /** Absolute path to a reference image for image-to-video, or null. */
  referenceImagePath: string | null;
  /** Where the provider must write the resulting clip. */
  outputClipPath: string;
}

export interface GenerateProgressEvent {
  /** 0..1, or null for indeterminate (heartbeat only). */
  progress: number | null;
}

export class ProviderError extends Error {
  readonly kind: 'unavailable' | 'timeout' | 'out-of-memory' | 'invalid-input' | 'server-error';

  constructor(
    kind: ProviderError['kind'],
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

export interface GenerationProvider {
  /** Probe the backend health and return its real capabilities. */
  capabilities(): Promise<ProviderCapabilities>;
  /**
   * Generate one clip. Must write the clip to `outputClipPath` and
   * resolve, or throw ProviderError. `onProgress` may be called with
   * { progress: null } as a heartbeat; real fractions only when the
   * backend reports them.
   */
  generate(
    request: GenerateRequest,
    onProgress: (event: GenerateProgressEvent) => void,
    signal: AbortSignal,
  ): Promise<void>;
}
