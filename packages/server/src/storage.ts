/**
 * Local file storage.
 *
 * - Everything lives under a single data root (VF_DATA_DIR), which the
 *   user self-hosts; no cloud storage is required or used.
 * - Keys are opaque storage keys ("projects/<id>/clips/scene1.mp4").
 *   Paths are resolved inside the root and validated against path
 *   traversal; any key that escapes the root is rejected.
 * - Files are NOT served publicly. Downloads go through an authorized
 *   server route that resolves keys server-side.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

export class PathTraversalError extends Error {
  constructor() {
    super('Invalid storage key.');
    this.name = 'PathTraversalError';
  }
}

export class Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Resolve a storage key to an absolute path inside the root. */
  resolveKey(key: string): string {
    if (typeof key !== 'string' || key.length === 0 || key.length > 500) {
      throw new PathTraversalError();
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/.test(key)) {
      throw new PathTraversalError();
    }
    const abs = resolve(join(this.root, key));
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new PathTraversalError();
    }
    return abs;
  }

  async write(key: string, data: Uint8Array | string): Promise<void> {
    const abs = this.resolveKey(key);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }

  async read(key: string): Promise<Buffer> {
    const abs = this.resolveKey(key);
    return readFile(abs);
  }

  async exists(key: string): Promise<boolean> {
    try {
      const abs = this.resolveKey(key);
      await stat(abs);
      return true;
    } catch {
      return false;
    }
  }

  async size(key: string): Promise<number> {
    const abs = this.resolveKey(key);
    const info = await stat(abs);
    return info.size;
  }

  async remove(key: string): Promise<void> {
    const abs = this.resolveKey(resolveKeySafe(key));
    await rm(abs, { force: true, recursive: true });
  }

  rootPath(): string {
    return this.root;
  }
}

function resolveKeySafe(key: string): string {
  return key;
}

function dirname(p: string): string {
  const idx = p.lastIndexOf(sep);
  if (idx === -1) {
    return p;
  }
  return p.slice(0, idx);
}

/** Sanitize a user-provided filename: strip directories and unsafe chars. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return cleaned.slice(0, 120);
}

/** Escape a value for use in an ffmpeg filter string. */
export function escapeFilterValue(value: string): string {
  return value.replace(/([\\':])/g, '\\$1');
}

/** Prevent double-quoting issues in ffmpeg drawtext fontfile paths. */
export function normalize(p: string): string {
  return p;
}
