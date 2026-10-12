import type { FileSystem } from './types.js';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const WINDOWS_INVALID = new Set(['<', '>', ':', '"', '|', '?', '*', '\\', '/']);

function replaceInvalid(name: string): string {
  let out = '';
  for (const char of name) {
    out += WINDOWS_INVALID.has(char) || char.charCodeAt(0) < 32 ? '_' : char;
  }
  return out;
}

export function portableName(fs: FileSystem, name: string): string {
  if (!fs.local || process.platform !== 'win32') return name;
  let safe = replaceInvalid(name).replace(/[. ]+$/, '');
  if (!safe) safe = '_';
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  return safe;
}

export function partName(name: string): string {
  const candidate = `.${name}.easyscp-part`;
  if (candidate.length <= 255) return candidate;
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `.${name.slice(0, 200)}~${hash.toString(36)}.easyscp-part`;
}

export function isPartName(name: string): boolean {
  return name.endsWith('.easyscp-part');
}
