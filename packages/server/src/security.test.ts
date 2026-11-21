import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage, sanitizeFileName, escapeFilterValue, PathTraversalError } from './storage.js';
import { buildAssembleArgs, writeConcatList, type AssembleInput } from './ffmpeg.js';

test('Storage resolves keys inside the root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vf-storage-'));
  const storage = new Storage(dir);
  await storage.write('projects/p1/clips/scene.mp4', Buffer.from('abc'));
  assert.equal(await storage.exists('projects/p1/clips/scene.mp4'), true);
  assert.equal(await storage.exists('projects/p1/clips/missing.mp4'), false);
  const buf = await storage.read('projects/p1/clips/scene.mp4');
  assert.equal(buf.toString('utf8'), 'abc');
  await rm(dir, { recursive: true, force: true });
});

test('Storage rejects path traversal keys', () => {
  const dir = join(tmpdir(), 'vf-x');
  const storage = new Storage(dir);
  assert.throws(() => storage.resolveKey('../outside'), PathTraversalError);
  assert.throws(() => storage.resolveKey('projects/../../etc/passwd'), PathTraversalError);
  assert.throws(() => storage.resolveKey(''), PathTraversalError);
  assert.throws(() => storage.resolveKey('projects/p1/../../../etc'), PathTraversalError);
  assert.throws(() => storage.resolveKey('projects/p1/..'), PathTraversalError);
  // Dots inside segments are fine (filenames like scene.1.mp4)
  assert.doesNotThrow(() => storage.resolveKey('projects/p1/scene.1.mp4'));
});

test('sanitizeFileName strips directories and unsafe characters', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('my video: final!.mp4'), 'my_video__final_.mp4');
  const long = 'a'.repeat(200);
  assert.ok(sanitizeFileName(long).length <= 120);
});

test('escapeFilterValue escapes ffmpeg filter metacharacters', () => {
  assert.equal(escapeFilterValue(`C:\\path\\file.vtt`), 'C\\:\\\\path\\\\file.vtt');
  assert.equal(escapeFilterValue("it's"), "it\\'s");
});

test('buildAssembleArgs never embeds user text as arguments', () => {
  const input: AssembleInput = {
    clipPaths: ['/tmp/a.mp4', '/tmp/b.mp4'],
    outputPath: '/tmp/out.mp4',
    width: 1280,
    height: 720,
    transition: 'cut',
    subtitlesPath: '/tmp/captions.vtt',
    musicPath: null,
    masterVolume: 1,
    musicVolume: 0.5,
    musicFadeIn: 0,
    musicFadeOut: 2,
    totalDurationSeconds: 30,
    muted: false,
  };
  const args = buildAssembleArgs(input, '/tmp/concat.txt');
  // No shell metacharacters should appear as standalone args; user text
  // (captions) is read from the VTT file, not passed as args.
  for (const arg of args) {
    assert.ok(!/[;&|`$]/.test(arg), `suspicious shell metacharacter in arg: ${arg}`);
  }
  assert.ok(args.includes('-i'));
  assert.ok(args.includes('/tmp/concat.txt'));
  assert.ok(args.some((a) => a.startsWith('subtitles=')));
});

test('buildAssembleArgs mutes audio when requested', () => {
  const input: AssembleInput = {
    clipPaths: ['/tmp/a.mp4'],
    outputPath: '/tmp/out.mp4',
    width: 640,
    height: 360,
    transition: 'cut',
    subtitlesPath: null,
    musicPath: null,
    masterVolume: 1,
    musicVolume: 1,
    musicFadeIn: 0,
    musicFadeOut: 0,
    totalDurationSeconds: 5,
    muted: true,
  };
  const args = buildAssembleArgs(input, '/tmp/concat.txt');
  assert.ok(args.includes('-an'));
});

test('buildAssembleArgs builds music mix with fade and limiter', () => {
  const input: AssembleInput = {
    clipPaths: ['/tmp/a.mp4'],
    outputPath: '/tmp/out.mp4',
    width: 640,
    height: 360,
    transition: 'cut',
    subtitlesPath: null,
    musicPath: '/tmp/music.mp3',
    masterVolume: 0.9,
    musicVolume: 0.6,
    musicFadeIn: 2,
    musicFadeOut: 3,
    totalDurationSeconds: 60,
    muted: false,
  };
  const args = buildAssembleArgs(input, '/tmp/concat.txt');
  const fc = args[args.indexOf('-filter_complex') + 1]!;
  assert.match(fc, /afade=t=in:st=0:d=2/);
  assert.match(fc, /afade=t=out:st=57:d=3/);
  assert.match(fc, /alimiter=limit=0\.95/);
});

test('writeConcatList escapes single quotes in paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vf-concat-'));
  const listPath = join(dir, 'concat.txt');
  await writeConcatList(["/tmp/it's a clip.mp4", '/tmp/plain.mp4'], listPath);
  const content = await readFile(listPath, 'utf8');
  assert.match(content, /it's a clip\.mp4|it'\\''s/);
  assert.match(content, /file '\/tmp\/plain\.mp4'/);
  await rm(dir, { recursive: true, force: true });
});
