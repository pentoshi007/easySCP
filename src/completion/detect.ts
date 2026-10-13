import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isShell, type Shell } from './scripts.js';

const run = promisify(execFile);

export function shellNamed(name: string | undefined): Shell | undefined {
  if (!name?.trim()) return undefined;
  const base = path
    .basename(name.trim().replaceAll('\\', '/'))
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
  if (base === 'pwsh' || base === 'powershell') return 'powershell';
  return isShell(base) ? base : undefined;
}

async function parentProcessName(): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      return await readFile(`/proc/${process.ppid}/comm`, 'utf8');
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run('ps', ['-o', 'comm=', '-p', String(process.ppid)], {
        timeout: 2000,
      });
      return stdout;
    }
  } catch {}
  return undefined;
}

export async function detectShell(): Promise<Shell | undefined> {
  return (
    shellNamed(await parentProcessName()) ??
    shellNamed(process.env.SHELL) ??
    (process.platform === 'win32' ? 'powershell' : undefined)
  );
}
