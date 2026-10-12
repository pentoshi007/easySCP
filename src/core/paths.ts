import os from 'node:os';
import path from 'node:path';

export function appDir(): string {
  const override = process.env.EASYSCP_HOME;
  if (override) return path.resolve(override);

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'easyscp');
  }

  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
  return path.join(configHome, 'easyscp');
}

export function appFile(name: string): string {
  return path.join(appDir(), name);
}

export function sshDir(): string {
  return path.join(os.homedir(), '.ssh');
}

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\'))
    return path.join(os.homedir(), input.slice(2));
  return input;
}

export function collapseHome(input: string): string {
  const home = os.homedir();
  if (input === home) return '~';
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  return input.startsWith(prefix) ? `~${path.sep}${input.slice(prefix.length)}` : input;
}
