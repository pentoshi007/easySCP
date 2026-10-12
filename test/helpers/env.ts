import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { isolateAppHome, tempDir } from './tmp.js';

export async function isolatedEnvironment(): Promise<{ home: string; sshDir: string }> {
  await isolateAppHome();
  const home = await tempDir('easyscp-user-');
  const sshDir = path.join(home, '.ssh');
  await mkdir(sshDir, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('SSH_AUTH_SOCK', '');
  return { home, sshDir };
}
