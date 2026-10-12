import type { Entry, FileSystem } from './types.js';

export function expandInput(fs: FileSystem, input: string): string {
  let value = input.trim();
  if (!fs.local) {
    value = value.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(value)) value = `/${value}`;
  }
  if (value === '~') return fs.home;
  if (value.startsWith('~/') || (fs.local && value.startsWith('~\\'))) {
    return fs.path.join(fs.home, value.slice(2));
  }
  return value;
}

export function resolveInput(fs: FileSystem, input: string, cwd: string): string {
  const expanded = expandInput(fs, input);
  if (!expanded) return cwd;
  return fs.path.isAbsolute(expanded)
    ? fs.path.normalize(expanded)
    : fs.path.resolve(cwd, expanded);
}

export function displayPath(fs: FileSystem, target: string): string {
  const { home, path } = fs;
  if (target === home) return '~';
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (home !== path.sep && target.startsWith(prefix)) {
    return `~${path.sep}${target.slice(prefix.length)}`;
  }
  return target;
}

export function parentDir(fs: FileSystem, target: string): string | undefined {
  const parent = fs.path.dirname(target);
  return parent === target ? undefined : parent;
}

export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export function compareEntries(a: Entry, b: Entry): number {
  const dirA = a.kind === 'dir' ? 0 : 1;
  const dirB = b.kind === 'dir' ? 0 : 1;
  if (dirA !== dirB) return dirA - dirB;
  const hiddenA = isHidden(a.name) ? 1 : 0;
  const hiddenB = isHidden(b.name) ? 1 : 0;
  if (hiddenA !== hiddenB) return hiddenA - hiddenB;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

export async function ensureDir(fs: FileSystem, dir: string): Promise<void> {
  const existing = await fs.stat(dir);
  if (existing?.kind === 'dir') return;
  if (existing) {
    throw Object.assign(new Error(`Not a directory: ${dir}`), { code: 'ENOTDIR', path: dir });
  }
  const parent = parentDir(fs, dir);
  if (parent) await ensureDir(fs, parent);
  try {
    await fs.mkdir(dir);
  } catch (error) {
    if ((await fs.stat(dir))?.kind !== 'dir') throw error;
  }
}

export async function removeTree(
  fs: FileSystem,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const entry = await fs.stat(target);
  if (!entry) return;
  if (entry.kind !== 'dir' || entry.link) {
    await fs.removeFile(target);
    return;
  }
  for (const child of await fs.scan(target)) {
    await removeTree(fs, fs.path.join(target, child.name), signal);
  }
  await fs.removeDir(target);
}

export async function uniqueName(fs: FileSystem, dir: string, name: string): Promise<string> {
  const ext = fs.path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let index = 1; index < 1000; index++) {
    const candidate = `${stem} (${index})${ext === name ? '' : ext}`;
    if (!(await fs.stat(fs.path.join(dir, candidate)))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}
