import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function tempDir(prefix = 'easyscp-'): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export async function useAppHome(): Promise<string> {
  const dir = await tempDir('easyscp-home-');
  process.env.EASYSCP_HOME = dir;
  process.env.EASYSCP_SECRETS = 'file';
  return dir;
}
