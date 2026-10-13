import { realpathSync } from 'node:fs';
import { isSea } from 'node:sea';

export type InstallMethod =
  | { kind: 'binary'; executable: string }
  | { kind: 'homebrew' }
  | { kind: 'npm' }
  | { kind: 'source' };

export interface InstallFacts {
  sea: boolean;
  executable: string;
  script: string | undefined;
}

function resolved(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export function currentInstall(): InstallFacts {
  return {
    sea: isSea(),
    executable: resolved(process.execPath),
    script: process.argv[1] ? resolved(process.argv[1]) : undefined,
  };
}

export function installMethod(facts: InstallFacts = currentInstall()): InstallMethod {
  const location = (facts.sea ? facts.executable : (facts.script ?? '')).replaceAll('\\', '/');
  if (location.includes('/Cellar/easyscp/')) return { kind: 'homebrew' };
  if (facts.sea) return { kind: 'binary', executable: facts.executable };
  if (/\/node_modules\/easyscp\//i.test(location)) return { kind: 'npm' };
  return { kind: 'source' };
}
