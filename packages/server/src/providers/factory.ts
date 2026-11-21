/**
 * Provider selection from environment variables.
 *
 * Secrets and endpoints live only in server-side environment variables.
 * Nothing here is exposed to the client bundle.
 *
 * Defaults: NO provider is configured. The app runs and the UI shows an
 * honest "backend not configured" state. No paid API is ever required
 * for the core workflow.
 */

import { readFileSync } from 'node:fs';
import { type GenerationProvider } from './provider.js';
import { UnconfiguredProvider } from './unconfigured.js';
import { ComfyUIProvider } from './comfyui.js';

export interface Env {
  get(name: string): string | undefined;
}

export class NodeEnv implements Env {
  get(name: string): string | undefined {
    return process.env[name];
  }
}

export function createProviderFromEnv(env: Env): GenerationProvider {
  const providerKind = env.get('VF_PROVIDER')?.trim().toLowerCase();
  if (providerKind === undefined || providerKind === '' || providerKind === 'none') {
    return new UnconfiguredProvider();
  }
  if (providerKind === 'comfyui') {
    const baseUrl = env.get('VF_COMFY_URL')?.trim() || 'http://127.0.0.1:8188';
    const textWorkflowPath = env.get('VF_COMFY_TEXT_WORKFLOW')?.trim() || '';
    if (textWorkflowPath === '') {
      return new UnconfiguredProvider(
        'VF_PROVIDER=comfyui is set, but VF_COMFY_TEXT_WORKFLOW is missing. Point it at your exported ComfyUI workflow JSON (see README).',
      );
    }
    const imageWorkflowPath = nonEmpty(env.get('VF_COMFY_IMAGE_WORKFLOW'));
    return new ComfyUIProvider({
      baseUrl,
      textWorkflowPath,
      imageWorkflowPath,
      promptNodeId: env.get('VF_COMFY_PROMPT_NODE')?.trim() || '6',
      negativeNodeId: orNull(env.get('VF_COMFY_NEGATIVE_NODE')),
      dimensionNodeId: orNull(env.get('VF_COMFY_DIMENSION_NODE')),
      seedNodeId: orNull(env.get('VF_COMFY_SEED_NODE')),
      imageNodeId: orNull(env.get('VF_COMFY_IMAGE_NODE')),
      outputNodeId: env.get('VF_COMFY_OUTPUT_NODE')?.trim() || 'VHS_VideoCombine',
    });
  }
  return new UnconfiguredProvider(
    `Unknown VF_PROVIDER "${providerKind}". Supported: comfyui, none. See README for backend setup.`,
  );
}

function nonEmpty(v: string | undefined): string | null {
  const trimmed = v?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : null;
}

function orNull(v: string | undefined): string | null {
  return nonEmpty(v);
}

/** Read the local backend env file (if any) into a plain map. */
export function loadEnvFile(path: string): Map<string, string> {
  const map = new Map<string, string>();
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return map;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}
