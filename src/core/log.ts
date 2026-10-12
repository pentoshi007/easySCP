import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { appFile } from './paths.js';

let target: string | undefined | null = null;

function logFile(): string | undefined {
  if (target !== null) return target;
  target = process.env.EASYSCP_DEBUG ? appFile('debug.log') : undefined;
  if (target) {
    try {
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    } catch {}
  }
  return target;
}

export function debugEnabled(): boolean {
  return logFile() !== undefined;
}

export function debugLog(message: string): void {
  const file = logFile();
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {}
}
