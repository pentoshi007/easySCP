import { AppError } from '../core/errors.js';
import { displayPath, parentDir, resolveInput } from './ops.js';
import type { FileSystem } from './types.js';

export function hasGlob(value: string): boolean {
  return /[*?[]/.test(value);
}

export function globToRegExp(pattern: string, caseSensitive: boolean): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] as string;
    if (char === '*') source += '[^/\\\\]*';
    else if (char === '?') source += '[^/\\\\]';
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end < 0) source += '\\[';
      else {
        const body = pattern
          .slice(index + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\');
        source += `[${body}]`;
        index = end;
      }
    } else source += char.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`, caseSensitive ? '' : 'i');
}

export async function expandPaths(
  fs: FileSystem,
  inputs: string[],
  cwd: string,
): Promise<string[]> {
  const caseSensitive = !(
    fs.local &&
    (process.platform === 'win32' || process.platform === 'darwin')
  );
  const results: string[] = [];
  for (const input of inputs) {
    const target = resolveInput(fs, input, cwd);
    if (await fs.stat(target)) {
      results.push(target);
      continue;
    }
    const name = fs.path.basename(target);
    const dir = parentDir(fs, target);
    if (dir && hasGlob(name) && !hasGlob(dir)) {
      const pattern = globToRegExp(name, caseSensitive);
      const showHidden = name.startsWith('.');
      const matches = (await fs.scan(dir).catch(() => []))
        .filter((entry) => pattern.test(entry.name) && (showHidden || !entry.name.startsWith('.')))
        .map((entry) => fs.path.join(dir, entry.name))
        .sort();
      if (matches.length > 0) {
        results.push(...matches);
        continue;
      }
      throw new AppError(`Nothing matches ${displayPath(fs, target)}`);
    }
    throw new AppError(
      `Not found: ${fs.local ? '' : `${fs.label}:`}${displayPath(fs, target)}`,
      fs.local
        ? undefined
        : `Remote paths are relative to your home folder (${displayPath(fs, fs.home)}).`,
    );
  }
  return [...new Set(results)];
}
