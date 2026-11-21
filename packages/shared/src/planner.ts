/**
 * Storyboard planner: turn a single high-level prompt into an editable
 * scene-by-scene plan before generation.
 *
 * Honesty rules:
 * - This planner is purely heuristic (template + keyword expansion).
 *   It is NOT a language model. It never claims to "understand" the
 *   prompt; it just segments it and adds cinematography vocabulary.
 * - Every generated scene prompt is fully editable before generation,
 *   and the UI labels the planner as heuristic.
 */

import type { Scene, GenerationMode, ProjectSettings } from './types.js';
import { planSceneDurations } from './duration.js';

const CAMERA_MOVES = [
  'slow dolly in',
  'slow pan left',
  'slow pan right',
  'gentle zoom out',
  'static shot',
  'tracking shot',
  'crane up',
  'dolly out',
  'handheld drift',
  'static wide shot',
];

const MOODS = [
  'soft natural light',
  'golden hour lighting',
  'moody atmospheric haze',
  'bright daylight',
  'cool blue evening tones',
  'warm interior lighting',
];

export interface PlanRequest {
  mode: GenerationMode;
  prompt: string;
  settings: ProjectSettings;
  /** Reference image name for image-to-video (used in scene 0 prompt only). */
  referenceImageName: string | null;
}

/** Split a prompt into `sceneCount` sentence-ish segments. */
export function segmentPrompt(prompt: string, sceneCount: number): string[] {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) {
    return Array.from({ length: sceneCount }, () => '');
  }
  let segments: string[] = normalized
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 0);
  if (segments.length < sceneCount) {
    const byComma = normalized.split(/,\s*/).filter((s) => s.trim().length > 0);
    if (byComma.length > segments.length) {
      segments = byComma;
    }
  }
  if (segments.length === 0) {
    segments = [normalized];
  }
  while (segments.length < sceneCount) {
    const longestIdx = segments.reduce(
      (max, s, i) => (s.length > segments[max]!.length ? i : max),
      0,
    );
    const longest = segments[longestIdx]!;
    const mid = Math.floor(longest.length / 2);
    const lastSpace = longest.lastIndexOf(' ', Math.max(1, mid));
    const cut = lastSpace > 0 ? lastSpace : mid;
    segments.splice(
      longestIdx,
      1,
      longest.slice(0, cut).trim(),
      longest.slice(cut).trim(),
    );
  }
  return segments.slice(0, sceneCount);
}

/** Build the editable storyboard for a new project. */
export function planStoryboard(request: PlanRequest): Scene[] {
  const { mode, prompt, settings } = request;
  const plan = planSceneDurations(
    settings.totalDurationSeconds,
    settings.sceneCount,
    settings.clipDurationSeconds,
  );
  const segments = segmentPrompt(prompt, settings.sceneCount);
  const scenes: Scene[] = [];
  for (let i = 0; i < settings.sceneCount; i++) {
    const segment = segments[i] ?? '';
    const camera = CAMERA_MOVES[i % CAMERA_MOVES.length]!;
    const mood = MOODS[i % MOODS.length]!;
    const parts: string[] = [];
    if (i === 0 && mode === 'image-to-video' && request.referenceImageName !== null) {
      parts.push(`Animate the uploaded image (${request.referenceImageName}): ${segment}`);
    } else if (segment === '') {
      parts.push(prompt);
    } else {
      parts.push(segment);
    }
    parts.push(camera);
    parts.push(mood);
    if (settings.style.trim() !== '') {
      parts.push(settings.style.trim());
    }
    scenes.push({
      id: crypto.randomUUID(),
      order: i,
      prompt: parts.filter((p) => p.trim().length > 0).join(', ').replace(/,\s*,/g, ', '),
      durationSeconds: plan.sceneDurations[i] ?? 1,
      referenceImage: null,
      status: 'pending',
      progress: null,
      outputKey: null,
      error: '',
      attempts: 0,
    });
  }
  return scenes;
}

/** Format caption text (one line per scene) into a WebVTT cue list. */
export function captionsToVtt(
  captionLines: string[],
  sceneDurations: number[],
): string {
  const cues: string[] = ['WEBVTT', ''];
  let start = 0;
  for (let i = 0; i < captionLines.length; i++) {
    const line = captionLines[i]?.trim() ?? '';
    const duration = sceneDurations[i] ?? 1;
    if (line.length === 0) {
      start += duration;
      continue;
    }
    const end = start + duration;
    cues.push(`${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`);
    cues.push(line);
    cues.push('');
    start = end;
  }
  return cues.join('\n');
}

function formatVttTimestamp(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const h = String(hours).padStart(2, '0');
  const m = String(minutes).padStart(2, '0');
  const s = String(seconds).padStart(2, '0');
  return `${h}:${m}:${s}.000`;
}

/** Reorder scenes: move scene at `from` to `to` (array indices). Returns a new array. */
export function reorderScenes(scenes: Scene[], from: number, to: number): Scene[] {
  if (from < 0 || to < 0 || from >= scenes.length || to >= scenes.length || from === to) {
    return scenes;
  }
  const next = [...scenes];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next.map((s, i) => ({ ...s, order: i }));
}

/** Parse one-line-per-scene caption text into an array of lines. */
export function parseCaptionText(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim());
}
