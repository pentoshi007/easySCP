import { AppError } from '../core/errors.js';
import { Semaphore } from '../util/concurrency.js';
import { printable } from '../util/format.js';
import type { Entry, FileSystem, RemoveOptions } from './types.js';

const REMOVE_CONCURRENCY = 32;
const REMOVE_PROGRESS_INTERVAL = 100;

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
  const resolved = fs.path.isAbsolute(expanded)
    ? fs.path.normalize(expanded)
    : fs.path.resolve(cwd, expanded);
  return stripTrailingSeparator(fs, resolved);
}

export function stripTrailingSeparator(fs: FileSystem, target: string): string {
  const { root } = fs.path.parse(target);
  let end = target.length;
  while (end > root.length && (target[end - 1] === '/' || target[end - 1] === fs.path.sep)) end--;
  return target.slice(0, end);
}

export function displayPath(fs: FileSystem, target: string): string {
  const { home, path } = fs;
  if (target === home) return '~';
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (home !== path.sep && target.startsWith(prefix)) {
    return printable(`~${path.sep}${target.slice(prefix.length)}`);
  }
  return printable(target);
}

export function parentDir(fs: FileSystem, target: string): string | undefined {
  const parent = fs.path.dirname(target);
  return parent === target ? undefined : parent;
}

export function isHidden(name: string): boolean {
  return name.startsWith('.');
}

export function compareEntries(a: Entry, b: Entry): number {
  const hiddenA = isHidden(a.name) ? 1 : 0;
  const hiddenB = isHidden(b.name) ? 1 : 0;
  if (hiddenA !== hiddenB) return hiddenA - hiddenB;
  const dirA = a.kind === 'dir' ? 0 : 1;
  const dirB = b.kind === 'dir' ? 0 : 1;
  if (dirA !== dirB) return dirA - dirB;
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

export async function createFolder(fs: FileSystem, dir: string, name: string): Promise<string> {
  const target = fs.path.join(dir, name.trim());
  if (await fs.stat(target)) throw new AppError(`${name.trim()} already exists`);
  await fs.mkdir(target);
  return target;
}

async function settleAll(tasks: Promise<void>[], signal?: AbortSignal): Promise<void> {
  const results = await Promise.allSettled(tasks);
  signal?.throwIfAborted();
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

export async function removeTrees(
  fs: FileSystem,
  targets: readonly string[],
  { signal, onProgress }: RemoveOptions = {},
): Promise<void> {
  const limit = new Semaphore(REMOVE_CONCURRENCY);
  let removed = 0;
  let reportedAt = 0;

  const run = <T>(task: () => Promise<T>) =>
    limit.run(() => {
      signal?.throwIfAborted();
      return task();
    });

  const counted = () => {
    removed++;
    const now = performance.now();
    if (onProgress && now - reportedAt >= REMOVE_PROGRESS_INTERVAL) {
      reportedAt = now;
      onProgress(removed);
    }
  };

  const removeDir = async (dir: string): Promise<void> => {
    const children = await run(() => fs.scan(dir));
    await settleAll(
      children.map((child) => removeEntry(fs.path.join(dir, child.name), child.dir)),
      signal,
    );
    await run(() => fs.removeDir(dir));
    counted();
  };

  const removeEntry = async (target: string, dir: boolean): Promise<void> => {
    if (dir) return removeDir(target);
    try {
      await run(() => fs.removeFile(target));
      counted();
    } catch (error) {
      if (signal?.aborted) throw error;
      const entry = await fs.stat(target);
      if (!entry) return;
      if (entry.kind === 'dir' && !entry.link) return removeDir(target);
      throw error;
    }
  };

  await settleAll(
    targets.map(async (target) => {
      const entry = await run(() => fs.stat(target));
      if (entry) await removeEntry(target, entry.kind === 'dir' && !entry.link);
    }),
    signal,
  );
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
