/**
 * VideoForge shared domain types.
 *
 * These types define the API contract between the web frontend and the
 * server. They are validated on the server side before any use; the
 * frontend mirrors them for display only.
 *
 * Honesty rules encoded in this model:
 * - Scene status is one of a fixed set of real states; there is no
 *   "fake success" state.
 * - Progress is only present when the backend actually reported it.
 *   `null` means "indeterminate" and the UI must show a spinner, not
 *   a fabricated percentage.
 */

/** Generation mode for a project. */
export type GenerationMode = 'text-to-video' | 'image-to-video';

/** Aspect ratios supported by the storyboard planner. */
export type AspectRatio = '16:9' | '9:16' | '1:1';

/** Scene-level status. */
export type SceneStatus =
  | 'pending'      // created, not yet queued
  | 'queued'       // accepted for generation
  | 'generating'   // backend accepted the scene
  | 'succeeded'    // clip file exists on disk
  | 'failed'       // generation errored; has `error`
  | 'canceled';    // canceled before completion

/** Project-level status. */
export type ProjectStatus =
  | 'draft'        // storyboard editable
  | 'generating'   // one or more scenes in flight
  | 'assembling'   // FFmpeg is stitching clips
  | 'completed'    // final output exists
  | 'failed';      // unrecoverable failure

/** Render job status. */
export type RenderJobStatus =
  | 'queued'
  | 'running'
  | 'canceled'
  | 'failed'
  | 'succeeded';

export const MIN_TOTAL_DURATION_SECONDS = 5;
export const MAX_TOTAL_DURATION_SECONDS = 300;

/** Project creation/update settings. All fields validated server-side. */
export interface ProjectSettings {
  /** Total target duration in seconds: 5..300. */
  totalDurationSeconds: number;
  aspectRatio: AspectRatio;
  /** Output height in pixels; must be in the backend's supported list. */
  outputHeight: number;
  /** Free-form visual direction appended to scene prompts (e.g. "cyberpunk, neon"). */
  style: string;
  /** Number of scenes the planner should create: 1..40. */
  sceneCount: number;
  /** Per-clip duration in seconds. Backend capability, not user-invented. */
  clipDurationSeconds: number;
  /** Optional seed for reproducibility when the backend supports it. */
  seed: number | null;
  /** Optional negative prompt applied to every scene. */
  negativePrompt: string;
  /** Transition between scenes: "cut" or a crossfade. */
  transition: 'cut' | 'crossfade';
  /** Caption mode. */
  captions: {
    /** Raw caption text typed by the user (one line per scene). */
    text: string;
    /** Burn captions into the output. */
    burnIn: boolean;
    /** Also export a .vtt sidecar file. */
    exportSidecar: boolean;
  };
  /** Audio settings. Volumes are 0..1; fades are seconds. */
  audio: {
    /** Muted flag for the whole output. */
    muted: boolean;
    /** Master output volume 0..1. */
    masterVolume: number;
    /** Uploaded music track reference (storage key) or null. */
    musicKey: string | null;
    /** Music volume 0..1 relative to master. */
    musicVolume: number;
    /** Fade in/out in seconds for music. */
    musicFadeIn: number;
    musicFadeOut: number;
  };
}

export interface SceneRefImage {
  /** Storage key of the uploaded reference image (not a public URL). */
  storageKey: string;
  /** Original filename, sanitized; display only. */
  originalName: string;
  /** MIME type validated server-side (image/png, image/jpeg, image/webp). */
  mimeType: string;
  /** Size in bytes at validation time. */
  sizeBytes: number;
}

export interface Scene {
  id: string;
  /** Zero-based display order in the storyboard. */
  order: number;
  prompt: string;
  /** Duration in seconds. Must sum across scenes to the target. */
  durationSeconds: number;
  /** Image reference for image-to-video mode. */
  referenceImage: SceneRefImage | null;
  status: SceneStatus;
  /** 0..1 when the backend reports progress; null = indeterminate. */
  progress: number | null;
  /** Storage key of the generated clip (mp4/webm), private by default. */
  outputKey: string | null;
  /** Human-readable failure message; empty when not failed. */
  error: string;
  /** How many times this scene has been retried. */
  attempts: number;
}

export interface Project {
  id: string;
  title: string;
  mode: GenerationMode;
  /** The single high-level prompt the user typed. */
  prompt: string;
  settings: ProjectSettings;
  scenes: Scene[];
  status: ProjectStatus;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  /** Storage key of the final assembled output, if any. */
  outputKey: string | null;
  /** Final output metadata, if completed. */
  output: ProjectOutputMetadata | null;
}

export interface ProjectOutputMetadata {
  /** Storage key of the file. */
  storageKey: string;
  /** File name for download headers. */
  fileName: string;
  /** Container format actually produced (e.g. "mp4"). */
  format: string;
  /** Video codec actually used (e.g. "h264"). */
  codec: string;
  durationSeconds: number;
  width: number;
  height: number;
  sizeBytes: number;
  /** ISO timestamp when output was produced. */
  producedAt: string;
}

export interface RenderJob {
  id: string;
  projectId: string;
  status: RenderJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** User requested cancellation. */
  cancelRequested: boolean;
  /** Summary error message when failed. */
  error: string;
  /** Output metadata when succeeded. */
  output: ProjectOutputMetadata | null;
}
