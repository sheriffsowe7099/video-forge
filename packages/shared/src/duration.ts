/**
 * Duration planning: split a target duration across scenes.
 *
 * Design notes:
 * - The planner must produce scene durations that sum exactly to the
 *   target duration (the spec requires this invariant).
 * - Per-clip duration is a backend capability. The planner distributes
 *   the remainder as single-second increments to the first scenes, so
 *   no scene exceeds the backend's supported clip duration when the
 *   total is a whole number of seconds.
 * - This module is pure and fully unit-tested. No IO.
 */

import {
  MAX_TOTAL_DURATION_SECONDS,
  MIN_TOTAL_DURATION_SECONDS,
} from './types.js';

export interface DurationPlan {
  /** Per-scene durations in display order; sums to target exactly. */
  sceneDurations: number[];
  /** Sum of sceneDurations; always equals target. */
  totalSeconds: number;
}

export function validateTotalDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
    return 'Total duration must be a whole number of seconds.';
  }
  if (seconds < MIN_TOTAL_DURATION_SECONDS) {
    return `Total duration must be at least ${MIN_TOTAL_DURATION_SECONDS} seconds.`;
  }
  if (seconds > MAX_TOTAL_DURATION_SECONDS) {
    return `Total duration cannot exceed ${MAX_TOTAL_DURATION_SECONDS} seconds (5 minutes).`;
  }
  return null;
}

export function validateSceneCount(sceneCount: number, targetSeconds: number): string | null {
  if (!Number.isInteger(sceneCount) || sceneCount < 1) {
    return 'Scene count must be at least 1.';
  }
  if (sceneCount > 40) {
    return 'Scene count cannot exceed 40 scenes.';
  }
  if (sceneCount > targetSeconds) {
    return 'Scene count cannot exceed the total duration in seconds (each scene needs at least one second).';
  }
  return null;
}

/**
 * Plan scene durations summing exactly to `targetSeconds`.
 * Longer clips are placed at the front; the last scenes may be 1s shorter.
 */
export function planSceneDurations(
  targetSeconds: number,
  sceneCount: number,
  clipDurationSeconds: number,
): DurationPlan {
  const durationError = validateTotalDuration(targetSeconds);
  if (durationError !== null) {
    throw new Error(`Invalid target duration: ${durationError}`);
  }
  const countError = validateSceneCount(sceneCount, targetSeconds);
  if (countError !== null) {
    throw new Error(`Invalid scene count: ${countError}`);
  }
  if (!Number.isFinite(clipDurationSeconds) || clipDurationSeconds < 1) {
    throw new Error('Clip duration must be at least 1 second.');
  }

  const base = Math.floor(targetSeconds / sceneCount);
  const remainder = targetSeconds - base * sceneCount;
  const sceneDurations: number[] = [];
  for (let i = 0; i < sceneCount; i++) {
    // Give the first `remainder` scenes one extra second.
    sceneDurations.push(base + (i < remainder ? 1 : 0));
  }
  return {
    sceneDurations,
    totalSeconds: sceneDurations.reduce((a, b) => a + b, 0),
  };
}

/** Check that scene durations sum to the project target. Returns null when OK. */
export function sceneDurationsSumError(
  durations: number[],
  targetSeconds: number,
): string | null {
  const sum = durations.reduce((a, b) => a + b, 0);
  if (sum !== targetSeconds) {
    return `Scene durations sum to ${sum}s but the project target is ${targetSeconds}s. Adjust scenes so they add up to ${targetSeconds}s.`;
  }
  return null;
}
