import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderFromEnv, type Env } from './providers/factory.js';
import { UnconfiguredProvider } from './providers/unconfigured.js';
import { ProviderError } from './providers/provider.js';

function envWith(map: Record<string, string>): Env {
  return {
    get(name: string): string | undefined {
      return map[name];
    },
  };
}

test('no VF_PROVIDER yields an honest UnconfiguredProvider', async () => {
  const provider = createProviderFromEnv(envWith({}));
  assert.ok(provider instanceof UnconfiguredProvider);
  const caps = await provider.capabilities();
  assert.equal(caps.available, false);
  assert.match(caps.unavailableReason!, /No generation backend is configured/);
  await assert.rejects(
    () => provider.generate({} as never, () => {}, new AbortController().signal),
    (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'unavailable');
      assert.match(err.message, /no backend is configured/i);
      return true;
    },
  );
});

test('VF_PROVIDER=none yields an honest UnconfiguredProvider', async () => {
  const provider = createProviderFromEnv(envWith({ VF_PROVIDER: 'none' }));
  assert.ok(provider instanceof UnconfiguredProvider);
});

test('comfyui without a text workflow reports the missing setting honestly', async () => {
  const provider = createProviderFromEnv(envWith({ VF_PROVIDER: 'comfyui' }));
  assert.ok(provider instanceof UnconfiguredProvider);
  const caps = await provider.capabilities();
  assert.match(caps.unavailableReason!, /VF_COMFY_TEXT_WORKFLOW is missing/);
});

test('unknown provider name reports an honest error', async () => {
  const provider = createProviderFromEnv(envWith({ VF_PROVIDER: 'paidapi' }));
  assert.ok(provider instanceof UnconfiguredProvider);
  const caps = await provider.capabilities();
  assert.match(caps.unavailableReason!, /Unknown VF_PROVIDER/);
});

test('comfyui provider is constructed with a workflow path', async () => {
  const provider = createProviderFromEnv(
    envWith({
      VF_PROVIDER: 'comfyui',
      VF_COMFY_TEXT_WORKFLOW: './workflows/text.json',
      VF_COMFY_URL: 'http://127.0.0.1:8188',
    }),
  );
  // Not unconfigured: it's a real adapter; capabilities probes the backend.
  assert.ok(!(provider instanceof UnconfiguredProvider));
  const caps = await provider.capabilities();
  // No ComfyUI is running in CI: must report unavailable with a reachable reason.
  assert.equal(caps.available, false);
  assert.ok(caps.unavailableReason !== null);
});
