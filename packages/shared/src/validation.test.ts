import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateImageMime,
  validateProjectSettings,
  validateTitle,
  validatePrompt,
  validateMode,
  MAX_IMAGE_BYTES,
} from './validation.js';

const heights = [512, 640, 768] as const;
const clips = [4, 6, 8] as const;

function validSettingsInput() {
  return {
    totalDurationSeconds: 30,
    aspectRatio: '16:9',
    outputHeight: 768,
    style: 'neon cyberpunk',
    sceneCount: 5,
    clipDurationSeconds: 6,
    seed: null,
    negativePrompt: '',
    transition: 'cut',
    captions: { text: '', burnIn: false, exportSidecar: false },
    audio: {
      muted: false,
      masterVolume: 1,
      musicVolume: 0.5,
      musicFadeIn: 0,
      musicFadeOut: 2,
      musicKey: null,
    },
  };
}

test('validateProjectSettings accepts a valid payload', () => {
  const result = validateProjectSettings(validSettingsInput(), heights, clips);
  assert.equal(result.ok, true);
  assert.equal(result.value!.outputHeight, 768);
});

test('validateProjectSettings rejects unsupported resolution for the backend', () => {
  const input = validSettingsInput();
  input.outputHeight = 1024; // not in backend-supported list
  const result = validateProjectSettings(input, heights, clips);
  assert.equal(result.ok, false);
  assert.match(result.error!, /does not support 1024px/);
});

test('validateProjectSettings rejects unsupported clip duration', () => {
  const input = validSettingsInput();
  input.clipDurationSeconds = 12; // backend supports 4/6/8
  const result = validateProjectSettings(input, heights, clips);
  assert.equal(result.ok, false);
  assert.match(result.error!, /clip durations of 4, 6, 8/);
});

test('validateProjectSettings rejects invalid volumes and fades', () => {
  const input = validSettingsInput();
  input.audio.masterVolume = 1.5;
  assert.equal(validateProjectSettings(input, heights, clips).ok, false);

  const input2 = validSettingsInput();
  input2.audio.musicFadeOut = -1;
  assert.equal(validateProjectSettings(input2, heights, clips).ok, false);
});

test('validateProjectSettings rejects bad aspect ratio and transition', () => {
  const input = validSettingsInput();
  input.aspectRatio = '4:3';
  assert.equal(validateProjectSettings(input, heights, clips).ok, false);

  const input2 = validSettingsInput();
  input2.transition = 'wipe';
  assert.equal(validateProjectSettings(input2, heights, clips).ok, false);
});

test('validateProjectSettings rejects seed out of range', () => {
  const input = validSettingsInput();
  input.seed = -5;
  assert.equal(validateProjectSettings(input, heights, clips).ok, false);
});

test('validateTitle and validatePrompt enforce presence and length', () => {
  assert.equal(validateTitle('   ').ok, false);
  assert.equal(validateTitle('My video').ok, true);
  assert.equal(validatePrompt('').ok, false);
  const long = 'a'.repeat(4001);
  assert.equal(validatePrompt(long).ok, false);
});

test('validateMode accepts only known modes', () => {
  assert.equal(validateMode('text-to-video').ok, true);
  assert.equal(validateMode('image-to-video').ok, true);
  assert.equal(validateMode('audio-to-video').ok, false);
});

test('validateImageMime enforces type and size', () => {
  assert.equal(validateImageMime('image/png', 1000).ok, true);
  assert.equal(validateImageMime('image/gif', 1000).ok, false);
  assert.equal(validateImageMime('image/png', 0).ok, false);
  const tooBig = validateImageMime('image/png', MAX_IMAGE_BYTES + 1);
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error!, /MiB/);
});
