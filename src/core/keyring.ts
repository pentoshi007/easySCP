import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getRawAsset, isSea } from 'node:sea';
import { cacheDir } from './paths.js';

export const KEYRING_ASSET = 'keyring.node';

const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

async function matches(file: string, expected: string): Promise<boolean> {
  const existing = await readFile(file).catch(() => undefined);
  return existing !== undefined && digest(existing) === expected;
}

export async function extractAsset(name: string, data: Uint8Array, root = cacheDir()) {
  const hash = digest(data);
  const file = path.join(root, 'native', `${hash.slice(0, 16)}-${name}`);
  if (await matches(file, hash)) return file;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o700 });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    if (!(await matches(file, hash))) throw error;
  }
  return file;
}

export async function loadKeyring<T>(): Promise<T> {
  if (!isSea()) return (await import('@napi-rs/keyring')) as T;
  const file = await extractAsset(KEYRING_ASSET, new Uint8Array(getRawAsset(KEYRING_ASSET)));
  const addon = { exports: {} as T };
  process.dlopen(addon, file);
  return addon.exports;
}
