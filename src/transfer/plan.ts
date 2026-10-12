import { AppError } from '../core/errors.js';
import { partName, portableName } from '../fs/names.js';
import { parentDir } from '../fs/ops.js';
import type { Entry, FileSystem } from '../fs/types.js';

export interface TransferSpec {
  source: FileSystem;
  target: FileSystem;
  sources: string[];
  destination: string;
}

export interface PlannedFile {
  source: string;
  target: string;
  relative: string;
  size: number;
  mtime: number;
  mode: number;
  existing: Entry | undefined;
  partial: number;
}

export interface SkippedItem {
  path: string;
  reason: string;
}

export interface TransferPlan {
  spec: TransferSpec;
  anchor: string;
  files: PlannedFile[];
  dirs: string[];
  totalBytes: number;
  skipped: SkippedItem[];
  conflicts: PlannedFile[];
}

export interface PlanOptions {
  signal?: AbortSignal;
  onScan?: (count: number) => void;
}

interface Item {
  entry: Entry;
  segments: string[];
}

const WALK_CONCURRENCY = 8;
const MTIME_TOLERANCE = 2000;

export function isIdentical(file: PlannedFile): boolean {
  const { existing } = file;
  return (
    existing !== undefined &&
    existing.kind === 'file' &&
    existing.size === file.size &&
    Math.abs(existing.mtime - file.mtime) < MTIME_TOLERANCE
  );
}

export function isNewer(file: PlannedFile): boolean {
  return !file.existing || file.mtime > file.existing.mtime + MTIME_TOLERANCE;
}

function endsWithSeparator(fs: FileSystem, target: string): boolean {
  return target.endsWith('/') || (fs.path.sep === '\\' && target.endsWith('\\'));
}

async function walk(
  fs: FileSystem,
  root: Entry,
  base: string[],
  items: Item[],
  skipped: SkippedItem[],
  options: PlanOptions,
): Promise<void> {
  const queue: { dir: string; segments: string[] }[] = [{ dir: root.path, segments: base }];
  let active = 0;
  let failure: unknown;

  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      if (failure !== undefined) reject(failure);
      else if (active === 0 && queue.length === 0) resolve();
    };
    const pump = () => {
      while (failure === undefined && active < WALK_CONCURRENCY && queue.length > 0) {
        const job = queue.shift() as { dir: string; segments: string[] };
        active++;
        fs.list(job.dir)
          .then((entries) => {
            options.signal?.throwIfAborted();
            for (const entry of entries) {
              const segments = [...job.segments, entry.name];
              if (entry.kind === 'dir' && entry.link) {
                skipped.push({ path: entry.path, reason: 'Symbolic link to a folder' });
              } else if (entry.kind === 'other') {
                skipped.push({ path: entry.path, reason: 'Not a regular file' });
              } else {
                items.push({ entry, segments });
                if (entry.kind === 'dir') queue.push({ dir: entry.path, segments });
              }
            }
            options.onScan?.(items.length);
          })
          .catch((error: unknown) => {
            if (options.signal?.aborted) failure = error;
            else skipped.push({ path: job.dir, reason: (error as Error).message });
          })
          .finally(() => {
            active--;
            pump();
            settle();
          });
      }
    };
    pump();
    settle();
  });
}

function containsPath(fs: FileSystem, parent: string, child: string): boolean {
  const relative = fs.path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !fs.path.isAbsolute(relative));
}

function compareSegments(a: string[], b: string[]): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const left = a[index] as string;
    const right = b[index] as string;
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length - b.length;
}

export async function planTransfer(
  spec: TransferSpec,
  options: PlanOptions = {},
): Promise<TransferPlan> {
  const { source, target, sources, destination } = spec;
  if (sources.length === 0) throw new AppError('Nothing selected to transfer');

  const destStat = await target.stat(destination);
  const single = sources.length === 1;
  let into: boolean;
  if (destStat?.kind === 'dir') into = true;
  else if (destStat) into = false;
  else into = !single || endsWithSeparator(target, destination);

  const roots: Entry[] = [];
  for (const path of sources) {
    const entry = await source.stat(path);
    if (!entry) throw new AppError(`Not found: ${path}`);
    if (source === target && entry.kind === 'dir' && containsPath(source, path, destination)) {
      throw new AppError(`Cannot copy ${path} into itself`);
    }
    roots.push(entry);
  }
  if (destStat && destStat.kind !== 'dir' && roots[0]?.kind === 'dir') {
    throw new AppError(`Destination is a file: ${destination}`);
  }

  const anchor = into ? destination : (parentDir(target, destination) ?? destination);
  const anchorStat = into ? destStat : await target.stat(anchor);
  if (anchorStat && anchorStat.kind !== 'dir') {
    throw new AppError(`Not a folder: ${anchor}`);
  }

  const items: Item[] = [];
  const skipped: SkippedItem[] = [];
  for (const root of roots) {
    options.signal?.throwIfAborted();
    const name = into ? portableName(target, root.name) : target.path.basename(destination);
    if (root.kind === 'other') {
      skipped.push({ path: root.path, reason: 'Not a regular file' });
      continue;
    }
    items.push({ entry: root, segments: [name] });
    if (root.kind === 'dir') await walk(source, root, [name], items, skipped, options);
  }
  items.sort((a, b) => compareSegments(a.segments, b.segments));

  const listings = new Map<string, Promise<Map<string, Entry>>>();
  const listing = (dir: string): Promise<Map<string, Entry>> => {
    let pending = listings.get(dir);
    if (!pending) {
      pending = (async () => {
        if (dir === anchor) {
          if (anchorStat?.kind !== 'dir') return new Map();
        } else {
          const parent = parentDir(target, dir);
          if (!parent) return new Map();
          const self = (await listing(parent)).get(target.path.basename(dir));
          if (self?.kind !== 'dir') return new Map();
        }
        const entries = await target.list(dir).catch(() => []);
        return new Map(entries.map((entry) => [entry.name, entry]));
      })();
      listings.set(dir, pending);
    }
    return pending;
  };

  const seen = new Set<string>();
  const blocked: string[] = [];
  const dirs: string[] = [];
  const files: PlannedFile[] = [];
  const isBlocked = (path: string) => blocked.some((prefix) => containsPath(target, prefix, path));

  for (const { entry, segments } of items) {
    const safe = segments.map((segment, index) =>
      index === 0 && !into ? segment : portableName(target, segment),
    );
    const destPath = target.path.join(anchor, ...safe);
    const relative = safe.join('/');
    if (seen.has(destPath)) {
      skipped.push({ path: entry.path, reason: 'Another selected item has the same name' });
      continue;
    }
    seen.add(destPath);
    if (isBlocked(destPath)) continue;

    const parent = parentDir(target, destPath) ?? anchor;
    const siblings = await listing(parent);
    const existing = siblings.get(target.path.basename(destPath));

    if (entry.kind === 'dir') {
      if (existing && existing.kind !== 'dir') {
        blocked.push(destPath);
        skipped.push({
          path: entry.path,
          reason: 'A file with the same name exists at the destination',
        });
      } else if (!existing) {
        dirs.push(destPath);
      }
      continue;
    }
    if (existing?.kind === 'dir') {
      skipped.push({
        path: entry.path,
        reason: 'A folder with the same name exists at the destination',
      });
      continue;
    }
    const part = siblings.get(partName(target.path.basename(destPath)));
    files.push({
      source: entry.path,
      target: destPath,
      relative,
      size: entry.size,
      mtime: entry.mtime,
      mode: entry.mode,
      existing,
      partial: part?.kind === 'file' ? part.size : 0,
    });
  }

  return {
    spec,
    anchor,
    files,
    dirs,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    skipped,
    conflicts: files.filter((file) => file.existing !== undefined),
  };
}
