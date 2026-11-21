import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from './jobstore.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeStore(): Promise<{ store: JobStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'vf-jobs-'));
  const store = new JobStore(join(dir, 'state'));
  await store.init();
  return { store, dir };
}

test('job store persists projects and jobs across instances', async () => {
  const { store, dir } = await makeStore();
  const project = {
    id: 'p1',
    title: 'T',
    mode: 'text-to-video' as const,
    prompt: 'x',
    settings: {} as never,
    scenes: [],
    status: 'draft' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputKey: null,
    output: null,
  };
  await store.createProject(project);
  await store.createJob({
    id: 'j1',
    projectId: 'p1',
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    error: '',
    output: null,
  });

  // New instance reads the same persisted data (durability).
  const reopened = new JobStore(join(dir, 'state'));
  await reopened.init();
  assert.equal(reopened.getProject('p1')?.title, 'T');
  assert.equal(reopened.getJob('j1')?.status, 'queued');

  await rm(dir, { recursive: true, force: true });
});

test('updateJob transitions status and sets cancelRequested', async () => {
  const { store, dir } = await makeStore();
  await store.createJob({
    id: 'j2',
    projectId: 'pX',
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    error: '',
    output: null,
  });
  await store.updateJob('j2', (j) => ({ ...j, status: 'running' }));
  assert.equal(store.getJob('j2')?.status, 'running');
  await store.requestCancel('j2');
  assert.equal(store.getJob('j2')?.cancelRequested, true);
  await store.updateJob('j2', (j) => ({ ...j, status: 'canceled', finishedAt: new Date().toISOString() }));
  assert.equal(store.getJob('j2')?.status, 'canceled');
  await rm(dir, { recursive: true, force: true });
});

test('deleteProject removes project and its jobs', async () => {
  const { store, dir } = await makeStore();
  await store.createProject({
    id: 'p3',
    title: 'T',
    mode: 'text-to-video' as const,
    prompt: 'x',
    settings: {} as never,
    scenes: [],
    status: 'draft' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputKey: null,
    output: null,
  });
  await store.createJob({
    id: 'j3',
    projectId: 'p3',
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    error: '',
    output: null,
  });
  const removed = await store.deleteProject('p3');
  assert.equal(removed, true);
  assert.equal(store.getProject('p3'), undefined);
  assert.equal(store.getJob('j3'), undefined);
  assert.equal(await store.deleteProject('p3'), false);
  await rm(dir, { recursive: true, force: true });
});

test('listProjects sorts by most recently updated', async () => {
  const { store, dir } = await makeStore();
  const now = new Date().toISOString();
  const base = {
    mode: 'text-to-video' as const,
    prompt: 'x',
    settings: {} as never,
    scenes: [],
    status: 'draft' as const,
    createdAt: now,
    outputKey: null,
    output: null,
  };
  await store.createProject({ ...base, id: 'old', title: 'Old', updatedAt: '2020-01-01T00:00:00.000Z' });
  await store.createProject({ ...base, id: 'new', title: 'New', updatedAt: '2024-01-01T00:00:00.000Z' });
  const list = store.listProjects();
  assert.equal(list[0]!.id, 'new');
  assert.equal(list[1]!.id, 'old');
  await rm(dir, { recursive: true, force: true });
});
