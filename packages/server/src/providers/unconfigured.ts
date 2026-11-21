/**
 * Unconfigured provider: the honest default.
 *
 * When no generation backend is configured (no VF_PROVIDER env var),
 * this provider reports unavailable with a readable explanation and
 * refuses to generate. The app shows "backend not configured" in the
 * UI and never fabricates a video or progress.
 */

import {
  type GenerationProvider,
  type GenerateRequest,
  type GenerateProgressEvent,
  type ProviderCapabilities,
  ProviderError,
} from './provider.js';

export class UnconfiguredProvider implements GenerationProvider {
  readonly reason: string;

  constructor(reason = 'No generation backend is configured. Set VF_PROVIDER (see README) to connect a self-hosted backend such as ComfyUI.') {
    this.reason = reason;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: 'none',
      name: 'Not configured',
      available: false,
      unavailableReason: this.reason,
      // Defaults the UI can use for storyboard drafting while unavailable.
      // These are app-level defaults, NOT claims about any backend.
      supportedHeights: [512, 640, 768],
      supportedClipDurations: [4, 6, 8],
      supportsImageToVideo: false,
      supportsSeed: false,
      supportsProgress: false,
    };
  }

  async generate(
    _request: GenerateRequest,
    _onProgress: (event: GenerateProgressEvent) => void,
    _signal: AbortSignal,
  ): Promise<void> {
    throw new ProviderError(
      'unavailable',
      'Generation is not possible: no backend is configured. Configure VF_PROVIDER and a backend URL (see README), then retry.',
    );
  }
}
