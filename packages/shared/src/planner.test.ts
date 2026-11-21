import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planStoryboard,
  segmentPrompt,
  captionsToVtt,
  reorderScenes,
  parseCaptionText,
} from './planner.js';
import type { ProjectSettings } from './types.js';

const settings: ProjectSettings = {
  totalDurationSeconds: 12,
  aspectRatio: '16:9',
  outputHeight: 768,
  style: 'watercolor',
  sceneCount: 3,
  clipDurationSeconds: 4,
  seed: null,
  negativePrompt: 'blurry',
  transition: 'cut',
  captions: { text: '', burnIn: false, exportSidecar: false },
  audio: {
    muted: false,
    masterVolume: 1,
    musicVolume: 0.5,
    musicFadeIn: 0,
    musicFadeOut: 0,
    musicKey: null,
  },
};

test('planStoryboard creates sceneCount scenes summing to target', () => {
  const scenes = planStoryboard({
    mode: 'text-to-video',
    prompt: 'A cat naps. It dreams of fish. It wakes and stretches.',
    settings,
    referenceImageName: null,
  });
  assert.equal(scenes.length, 3);
  const total = scenes.reduce((a, s) => a + s.durationSeconds, 0);
  assert.equal(total, 12);
  for (const s of scenes) {
    assert.equal(s.status, 'pending');
    assert.match(s.prompt, /watercolor/);
  }
});

test('planStoryboard image-to-video first scene references the uploaded image', () => {
  const scenes = planStoryboard({
    mode: 'image-to-video',
    prompt: 'Bring the photo to life.',
    settings,
    referenceImageName: 'photo.png',
  });
  assert.match(scenes[0]!.prompt, /Animate the uploaded image \(photo\.png\)/);
});

test('segmentPrompt splits long prompts into the requested count', () => {
  const segments = segmentPrompt(
    'one two three four five six seven eight nine ten eleven twelve',
    4,
  );
  assert.equal(segments.length, 4);
});

test('captionsToVtt produces valid VTT structure', () => {
  const vtt = captionsToVtt(['Hello', '', 'World'], [4, 4, 4]);
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /00:00:00\.000 --> 00:00:04\.000/);
  assert.match(vtt, /00:00:08\.000 --> 00:00:12\.000/);
  assert.match(vtt, /Hello/);
  assert.match(vtt, /World/);
  // Empty line must not produce a cue but must advance the clock.
  assert.doesNotMatch(vtt, /--> 00:00:0[47]\.000\n\n$/);
});

test('reorderScenes reindexes orders after a move', () => {
  const base = planStoryboard({
    mode: 'text-to-video',
    prompt: 'a. b. c.',
    settings,
    referenceImageName: null,
  });
  const moved = reorderScenes(base, 2, 0);
  assert.equal(moved[0]!.prompt, base[2]!.prompt);
  assert.deepEqual(
    moved.map((s) => s.order),
    [0, 1, 2],
  );
});

test('parseCaptionText splits and trims lines', () => {
  const lines = parseCaptionText('first\n  second  \r\n\r\nthird');
  assert.deepEqual(lines, ['first', 'second', '', 'third']);
});

test('reorderScenes is a no-op for invalid indices', () => {
  const base = planStoryboard({
    mode: 'text-to-video',
    prompt: 'a. b. c.',
    settings,
    referenceImageName: null,
  });
  assert.deepEqual(reorderScenes(base, 0, 0), base);
  assert.deepEqual(reorderScenes(base, -1, 0), base);
  assert.deepEqual(reorderScenes(base, 0, 9), base);
});
