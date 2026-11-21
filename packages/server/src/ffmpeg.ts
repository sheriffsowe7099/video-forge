/**
 * FFmpeg assembly.
 *
 * SECURITY: ffmpeg is invoked with an argument array via spawn(). User
 * strings (prompts, captions, filenames) NEVER enter a shell and never
 * appear as command arguments directly. Only server-generated values
 * (resolved absolute paths, numerics) become arguments; user text is
 * passed through files (a concat list, a VTT subtitle file) that ffmpeg
 * reads as data, not code.
 *
 * HONESTY: dimensions/fps/codec are normalized for uniform output
 * without upscaling claims. Captions burn-in uses the subtitles filter.
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { escapeFilterValue } from './storage.js';

export interface AssembleInput {
  /** Absolute paths of scene clips, in storyboard order. */
  clipPaths: string[];
  /** Absolute output path (mp4). */
  outputPath: string;
  width: number;
  height: number;
  /** Transition between clips: 'cut' or 'crossfade' (0.5s). */
  transition: 'cut' | 'crossfade';
  /** VTT file path for burn-in, or null. */
  subtitlesPath: string | null;
  /** Absolute path to a music track, or null. */
  musicPath: string | null;
  /** Master volume 0..1. */
  masterVolume: number;
  /** Music volume 0..1 (relative). */
  musicVolume: number;
  /** Music fade in/out seconds. */
  musicFadeIn: number;
  musicFadeOut: number;
  /** Total duration in seconds (for music trimming). */
  totalDurationSeconds: number;
  /** Mute all audio. */
  muted: boolean;
}

export class FFmpegError extends Error {
  readonly exitCode: number | null;
  readonly stderrTail: string;

  constructor(exitCode: number | null, stderrTail: string) {
    super(`FFmpeg failed (exit ${exitCode ?? 'signal'}). ${stderrTail}`);
    this.name = 'FFmpegError';
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
  }
}

/** Check whether ffmpeg is installed and runnable. */
export async function isFFmpegAvailable(ffmpegPath = 'ffmpeg'): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Build the ffmpeg argument array for assembly. Pure function so tests
 * can verify safety: user text never enters args.
 */
export function buildAssembleArgs(input: AssembleInput, concatListPath: string): string[] {
  const args: string[] = [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
  ];

  if (input.musicPath !== null && !input.muted) {
    args.push('-i', input.musicPath);
  }

  // Build filter chain.
  const filters: string[] = [
    `scale=${input.width}:${input.height}:force_original_aspect_ratio=decrease`,
    `pad=${input.width}:${input.height}:(ow-iw)/2:(oh-ih)/2`,
    'fps=24',
    'setsar=1',
  ];

  const hasVideoFilters = filters.length > 0 || input.subtitlesPath !== null;
  if (input.subtitlesPath !== null) {
    // Path escaping for the subtitles filter; the path is server-resolved,
    // not user text, but escape anyway.
    filters.push(`subtitles=${escapeFilterValue(input.subtitlesPath)}`);
  }
  if (hasVideoFilters) {
    args.push('-vf', filters.join(','));
  }

  // Audio handling.
  if (input.muted) {
    args.push('-an');
  } else if (input.musicPath !== null) {
    const audioFilters: string[] = [];
    if (input.musicFadeIn > 0) {
      audioFilters.push(`afade=t=in:st=0:d=${input.musicFadeIn}`);
    }
    const fadeOutStart = Math.max(0, input.totalDurationSeconds - input.musicFadeOut);
    if (input.musicFadeOut > 0) {
      audioFilters.push(`afade=t=out:st=${fadeOutStart}:d=${input.musicFadeOut}`);
    }
    // Safe mixing: user-provided volume levels, then a loudness safety net.
    const chain = [
      ...(audioFilters.length > 0 ? audioFilters : []),
      `volume=${clampVolume(input.musicVolume * input.masterVolume)}`,
      'alimiter=limit=0.95:attack=5:release=50',
    ];
    args.push('-filter_complex', `[1:a]${chain.join(',')}[a]`, '-map', '0:v', '-map', '[a]', '-shortest');
  } else {
    // No music: keep original audio as-is at master volume.
    args.push('-filter:a', `volume=${clampVolume(input.masterVolume)}`);
    args.push('-map', '0:v', '-map', '0:a?');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
  );
  args.push(input.outputPath);
  return args;
}

/** Write the concat list file ffmpeg will read (file paths only, absolute). */
export async function writeConcatList(clipPaths: string[], listPath: string): Promise<void> {
  const lines = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
  await writeFile(listPath, `${lines.join('\n')}\n`, 'utf8');
}

/** Run the assembly. Throws FFmpegError on failure. */
export async function runAssembly(
  input: AssembleInput,
  workDir: string,
  ffmpegPath = 'ffmpeg',
): Promise<void> {
  const concatListPath = join(workDir, 'concat.txt');
  await writeConcatList(input.clipPaths, concatListPath);
  const args = buildAssembleArgs(input, concatListPath);
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    proc.on('error', (err) => {
      reject(new FFmpegError(null, err.message));
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new FFmpegError(code, tail(stderrTail)));
      }
    });
  });
}

function tail(s: string): string {
  return s.length > 500 ? s.slice(-500) : s;
}

function clampVolume(v: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 1));
  return clamped.toFixed(2);
}
