/**
 * Validation schemas shared by server routes.
 *
 * The server never trusts client input. Every endpoint parses its payload
 * through one of these schemas and rejects invalid data with a 400 and
 * a readable message. The frontend uses the same limits for its own
 * hints, but server-side validation is authoritative.
 *
 * Hand-rolled validators are used (no external schema library) to keep
 * the dependency footprint small; each validator returns a typed result.
 */

import {
  MAX_TOTAL_DURATION_SECONDS,
  MIN_TOTAL_DURATION_SECONDS,
  type AspectRatio,
  type GenerationMode,
  type ProjectSettings,
  type Scene,
} from './types.js';
import { planSceneDurations, sceneDurationsSumError } from './duration.js';

export const PROMPT_MAX_LENGTH = 4000;
export const NEGATIVE_PROMPT_MAX_LENGTH = 1000;
export const STYLE_MAX_LENGTH = 200;
export const TITLE_MAX_LENGTH = 120;
export const CAPTION_TEXT_MAX_LENGTH = 20000;
export const MAX_SCENES = 40;
export const ALLOWED_ASPECT_RATIOS: readonly AspectRatio[] = ['16:9', '9:16', '1:1'];
export const ALLOWED_MODES: readonly GenerationMode[] = ['text-to-video', 'image-to-video'];
export const ALLOWED_OUTPUT_HEIGHTS: readonly number[] = [512, 640, 768, 1024];
export const ALLOWED_TRANSITIONS: readonly ('cut' | 'crossfade')[] = ['cut', 'crossfade'];

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function bad<T>(error: string): ValidationResult<T> {
  return { ok: false, error };
}

function good<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampVolume(value: unknown, field: string): ValidationResult<number> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return bad(`${field} must be a number between 0 and 1.`);
  }
  return good(value);
}

function clampNonNegativeInt(value: unknown, field: string, max: number): ValidationResult<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    return bad(`${field} must be an integer between 0 and ${max}.`);
  }
  return good(value);
}

export function validateTitle(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return bad('Title is required.');
  }
  if (value.length > TITLE_MAX_LENGTH) {
    return bad(`Title must be at most ${TITLE_MAX_LENGTH} characters.`);
  }
  return good(value.trim());
}

export function validatePrompt(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return bad('Prompt is required.');
  }
  if (value.length > PROMPT_MAX_LENGTH) {
    return bad(`Prompt must be at most ${PROMPT_MAX_LENGTH} characters.`);
  }
  return good(value.trim());
}

export function validateOptionalPrompt(value: unknown, field: string, max: number): ValidationResult<string> {
  if (value === undefined || value === null || value === '') {
    return good('');
  }
  if (typeof value !== 'string') {
    return bad(`${field} must be a string.`);
  }
  if (value.length > max) {
    return bad(`${field} must be at most ${max} characters.`);
  }
  return good(value);
}

/** Image validation constants. Mirrored in server upload route and tests. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MiB
export const MAX_IMAGE_DIMENSION = 4096; // px, on the longest side
export const ALLOWED_IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
export const ALLOWED_IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.webp'];

export function validateImageMime(mimeType: string | undefined, sizeBytes: number): ValidationResult<{ mimeType: string }> {
  if (mimeType === undefined || !ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
    return bad(`Unsupported image type. Allowed: ${ALLOWED_IMAGE_MIME_TYPES.join(', ')}.`);
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return bad('Image file appears to be empty.');
  }
  if (sizeBytes > MAX_IMAGE_BYTES) {
    return bad(`Image exceeds the ${Math.floor(MAX_IMAGE_BYTES / (1024 * 1024))} MiB limit.`);
  }
  return good({ mimeType });
}

/** Audio upload limits. */
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MiB
export const ALLOWED_AUDIO_MIME_TYPES: readonly string[] = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/flac'];

export interface SettingsInput {
  totalDurationSeconds: unknown;
  aspectRatio: unknown;
  outputHeight: unknown;
  style: unknown;
  sceneCount: unknown;
  clipDurationSeconds: unknown;
  seed: unknown;
  negativePrompt: unknown;
  transition: unknown;
  captions: unknown;
  audio: unknown;
}

export function validateProjectSettings(
  input: SettingsInput,
  supportedHeights: readonly number[],
  supportedClipDurations: readonly number[],
): ValidationResult<ProjectSettings> {
  const totalDurationSeconds = input.totalDurationSeconds;
  if (
    typeof totalDurationSeconds !== 'number' ||
    !Number.isInteger(totalDurationSeconds) ||
    totalDurationSeconds < MIN_TOTAL_DURATION_SECONDS ||
    totalDurationSeconds > MAX_TOTAL_DURATION_SECONDS
  ) {
    return bad(`Total duration must be a whole number of seconds between ${MIN_TOTAL_DURATION_SECONDS} and ${MAX_TOTAL_DURATION_SECONDS}.`);
  }

  const aspectRatio = input.aspectRatio;
  if (typeof aspectRatio !== 'string' || !ALLOWED_ASPECT_RATIOS.includes(aspectRatio as AspectRatio)) {
    return bad(`Aspect ratio must be one of: ${ALLOWED_ASPECT_RATIOS.join(', ')}.`);
  }

  const outputHeight = input.outputHeight;
  if (typeof outputHeight !== 'number' || !ALLOWED_OUTPUT_HEIGHTS.includes(outputHeight)) {
    return bad(`Output resolution must be one of: ${ALLOWED_OUTPUT_HEIGHTS.join(', ')} px (height).`);
  }
  if (!supportedHeights.includes(outputHeight)) {
    return bad(
      `The configured generation backend does not support ${outputHeight}px output. Supported by this backend: ${supportedHeights.join(', ')} px.`,
    );
  }

  const style = input.style === undefined || input.style === null ? '' : input.style;
  if (typeof style !== 'string' || style.length > STYLE_MAX_LENGTH) {
    return bad(`Style must be at most ${STYLE_MAX_LENGTH} characters.`);
  }

  const sceneCount = input.sceneCount;
  if (typeof sceneCount !== 'number' || !Number.isInteger(sceneCount) || sceneCount < 1 || sceneCount > MAX_SCENES) {
    return bad(`Scene count must be an integer between 1 and ${MAX_SCENES}.`);
  }

  const clipDurationSeconds = input.clipDurationSeconds;
  if (typeof clipDurationSeconds !== 'number' || !Number.isInteger(clipDurationSeconds) || clipDurationSeconds < 1 || clipDurationSeconds > 20) {
    return bad('Clip duration must be a whole number of seconds between 1 and 20.');
  }
  if (!supportedClipDurations.includes(clipDurationSeconds)) {
    return bad(
      `The configured generation backend supports clip durations of ${supportedClipDurations.join(', ')} seconds only. Adjust the clip duration setting.`,
    );
  }

  const seed = input.seed;
  let seedValue: number | null = null;
  if (seed !== undefined && seed !== null && seed !== '') {
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > Number.MAX_SAFE_INTEGER) {
      return bad('Seed must be a non-negative integer or empty.');
    }
    seedValue = seed;
  }

  const negativePrompt = input.negativePrompt === undefined || input.negativePrompt === null ? '' : input.negativePrompt;
  if (typeof negativePrompt !== 'string' || negativePrompt.length > NEGATIVE_PROMPT_MAX_LENGTH) {
    return bad(`Negative prompt must be at most ${NEGATIVE_PROMPT_MAX_LENGTH} characters.`);
  }

  const transition = input.transition;
  if (typeof transition !== 'string' || !ALLOWED_TRANSITIONS.includes(transition as 'cut' | 'crossfade')) {
    return bad('Transition must be "cut" or "crossfade".');
  }

  if (!isRecord(input.captions)) {
    return bad('Captions must be an object.');
  }
  const captionText = input.captions.text === undefined || input.captions.text === null ? '' : input.captions.text;
  if (typeof captionText !== 'string' || captionText.length > CAPTION_TEXT_MAX_LENGTH) {
    return bad(`Caption text must be at most ${CAPTION_TEXT_MAX_LENGTH} characters.`);
  }
  if (typeof input.captions.burnIn !== 'boolean' || typeof input.captions.exportSidecar !== 'boolean') {
    return bad('Caption burnIn and exportSidecar must be booleans.');
  }

  if (!isRecord(input.audio)) {
    return bad('Audio must be an object.');
  }
  const muted = input.audio.muted;
  if (typeof muted !== 'boolean') {
    return bad('Audio muted must be a boolean.');
  }
  const masterVolume = clampVolume(input.audio.masterVolume, 'Master volume');
  if (!masterVolume.ok) return bad(masterVolume.error!);
  const musicVolume = clampVolume(input.audio.musicVolume, 'Music volume');
  if (!musicVolume.ok) return bad(musicVolume.error!);
  const musicFadeIn = clampNonNegativeInt(input.audio.musicFadeIn, 'Music fade-in', 30);
  if (!musicFadeIn.ok) return bad(musicFadeIn.error!);
  const musicFadeOut = clampNonNegativeInt(input.audio.musicFadeOut, 'Music fade-out', 30);
  if (!musicFadeOut.ok) return bad(musicFadeOut.error!);

  const musicKey = input.audio.musicKey;
  if (musicKey !== undefined && musicKey !== null && musicKey !== '') {
    if (typeof musicKey !== 'string' || musicKey.length > 300 || !/^[a-zA-Z0-9/_-]+$/.test(musicKey)) {
      return bad('Music key must be a simple storage key (letters, digits, dash, slash).');
    }
  }

  return good({
    totalDurationSeconds,
    aspectRatio: aspectRatio as AspectRatio,
    outputHeight,
    style,
    sceneCount,
    clipDurationSeconds,
    seed: seedValue,
    negativePrompt,
    transition: transition as 'cut' | 'crossfade',
    captions: {
      text: captionText,
      burnIn: input.captions.burnIn as boolean,
      exportSidecar: input.captions.exportSidecar as boolean,
    },
    audio: {
      muted,
      masterVolume,
      musicVolume,
      musicFadeIn,
      musicFadeOut,
      musicKey: typeof musicKey === 'string' && musicKey !== '' ? musicKey : null,
    },
  });
}

export function validateMode(value: unknown): ValidationResult<GenerationMode> {
  if (typeof value !== 'string' || !ALLOWED_MODES.includes(value as GenerationMode)) {
    return bad(`Mode must be one of: ${ALLOWED_MODES.join(', ')}.`);
  }
  return good(value as GenerationMode);
}

export function validateSceneInput(
  scene: Record<string, unknown>,
  projectTargetSeconds: number,
  projectSceneCount: number,
  supportedClipDurations: readonly number[],
): ValidationResult<Scene> {
  if (typeof scene.prompt !== 'string' || scene.prompt.trim().length === 0) {
    return bad('Scene prompt is required.');
  }
  if (scene.prompt.length > PROMPT_MAX_LENGTH) {
    return bad(`Scene prompt must be at most ${PROMPT_MAX_LENGTH} characters.`);
  }
  const duration = scene.durationSeconds;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 1 || duration > 20) {
    return bad('Scene duration must be a whole number of seconds between 1 and 20.');
  }
  if (!supportedClipDurations.includes(duration)) {
    return bad(`Scene duration must be one of the backend-supported clip durations: ${supportedClipDurations.join(', ')}s.`);
  }
  void projectTargetSeconds;
  void projectSceneCount;
  return good({
    id: typeof scene.id === 'string' && scene.id.length > 0 ? scene.id : crypto.randomUUID(),
    order: 0,
    prompt: scene.prompt.trim(),
    durationSeconds: duration,
    referenceImage: null,
    status: 'pending',
    progress: null,
    outputKey: null,
    error: '',
    attempts: 0,
  });
}
