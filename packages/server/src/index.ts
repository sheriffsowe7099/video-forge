/**
 * Server entry point. Starts the HTTP API and the retention cleanup timer.
 */

import { mkdir } from 'node:fs/promises';
import { loadConfig, createApp } from './app.js';
import { cleanupOldProjects } from './pipeline.js';

const config = loadConfig(process.env);
const app = createApp(config);

async function main(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await app.jobStore.init();
  app.server.listen(config.port, config.host, () => {
    console.log(`[video-forge] API listening on http://${config.host}:${config.port}`);
    console.log(`[video-forge] Data directory: ${config.dataDir}`);
    const providerKind = process.env.VF_PROVIDER ?? 'none';
    if (providerKind === 'none' || providerKind === '') {
      console.log(
        '[video-forge] No generation backend configured (VF_PROVIDER not set). The UI will show "backend not configured" and generation will be unavailable until you configure one. See README.',
      );
    } else {
      console.log(`[video-forge] Generation backend: ${providerKind}`);
    }
  });

  // Retention cleanup: daily removal of completed project data older than VF_RETENTION_DAYS.
  const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    void cleanupOldProjects(app.jobStore, app.storage, config.retentionDays).catch(() => {});
  }, CLEANUP_INTERVAL_MS);
}

void main();
