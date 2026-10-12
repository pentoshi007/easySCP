import { describeError } from '../../core/errors.js';
import { compareEntries } from '../../fs/ops.js';
import { type IndexEntry, indexTree } from '../../fs/search.js';
import type { Entry, FileSystem } from '../../fs/types.js';

const MAX_CACHED_DIRS = 256;
const NOTIFY_INTERVAL = 120;

export class DirCache {
  private readonly entries = new Map<string, Entry[]>();
  private readonly pending = new Map<string, Promise<Entry[]>>();

  constructor(readonly fs: FileSystem) {}

  peek(dir: string): Entry[] | undefined {
    const hit = this.entries.get(dir);
    if (hit) {
      this.entries.delete(dir);
      this.entries.set(dir, hit);
    }
    return hit;
  }

  load(dir: string, force = false): Promise<Entry[]> {
    if (!force) {
      const hit = this.peek(dir);
      if (hit) return Promise.resolve(hit);
    }
    const inflight = this.pending.get(dir);
    if (inflight) return inflight;
    const request = this.fs
      .list(dir)
      .then((list) => {
        const sorted = list.sort(compareEntries);
        this.entries.set(dir, sorted);
        while (this.entries.size > MAX_CACHED_DIRS) {
          const oldest = this.entries.keys().next().value as string;
          this.entries.delete(oldest);
        }
        return sorted;
      })
      .finally(() => this.pending.delete(dir));
    this.pending.set(dir, request);
    return request;
  }

  prefetch(dir: string): void {
    if (this.entries.has(dir) || this.pending.has(dir) || this.fs.closed) return;
    this.load(dir).catch(() => undefined);
  }

  invalidate(dir: string): void {
    this.entries.delete(dir);
  }
}

const caches = new WeakMap<FileSystem, DirCache>();

export function cacheFor(fs: FileSystem): DirCache {
  let cache = caches.get(fs);
  if (!cache) {
    cache = new DirCache(fs);
    caches.set(fs, cache);
  }
  return cache;
}

export type IndexStatus = 'running' | 'done' | 'error';

export class DeepIndex {
  readonly paths: string[] = [];
  readonly lower: string[] = [];
  readonly dirs: boolean[] = [];
  status: IndexStatus = 'running';
  truncated = false;
  error: string | undefined;
  version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    readonly fs: FileSystem,
    readonly root: string,
  ) {
    indexTree(fs, root, {
      signal: this.controller.signal,
      onEntries: (batch) => this.add(batch),
    }).then(
      (result) => {
        this.truncated = result.truncated;
        this.status = 'done';
        this.flush();
      },
      (error: unknown) => {
        if (this.controller.signal.aborted) return;
        this.status = 'error';
        this.error = describeError(error).message;
        this.flush();
      },
    );
  }

  get count(): number {
    return this.paths.length;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  abort(): void {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }

  private add(batch: IndexEntry[]): void {
    for (const entry of batch) {
      this.paths.push(entry.path);
      this.lower.push(entry.path.toLowerCase());
      this.dirs.push(entry.dir);
    }
    this.timer ??= setTimeout(() => this.flush(), NOTIFY_INTERVAL);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
