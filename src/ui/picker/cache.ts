import { describeError } from '../../core/errors.js';
import { compareEntries } from '../../fs/ops.js';
import { type IndexEntry, indexTree } from '../../fs/search.js';
import type { Entry, FileSystem } from '../../fs/types.js';

const MAX_CACHED_DIRS = 256;
const NOTIFY_INTERVAL = 120;

export interface DirSnapshot {
  entries: Entry[] | undefined;
  error: string | undefined;
  revision: number;
}

interface Cached extends DirSnapshot {
  loadedAt: number;
}

interface Request {
  ticket: number;
  promise: Promise<void>;
}

const UNLOADED: DirSnapshot = { entries: undefined, error: undefined, revision: 0 };

function sameEntries(previous: Entry[], next: Entry[]): boolean {
  return (
    previous.length === next.length &&
    previous.every((entry, index) => {
      const other = next[index] as Entry;
      return (
        entry.path === other.path &&
        entry.kind === other.kind &&
        entry.link === other.link &&
        entry.size === other.size &&
        entry.mtime === other.mtime &&
        entry.mode === other.mode
      );
    })
  );
}

export class DirCache {
  private readonly listings = new Map<string, Cached>();
  private readonly requests = new Map<string, Request>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private tickets = 0;

  constructor(readonly fs: FileSystem) {}

  snapshot(dir: string): DirSnapshot {
    return this.listings.get(dir) ?? UNLOADED;
  }

  subscribe(dir: string, listener: () => void): () => void {
    const listeners = this.listeners.get(dir) ?? new Set();
    listeners.add(listener);
    this.listeners.set(dir, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(dir);
    };
  }

  refresh(dir: string): Promise<void> {
    return this.fetch(dir);
  }

  revalidate(dir: string, maxAge = 0): Promise<void> {
    const pending = this.requests.get(dir);
    if (pending) return pending.promise;
    const cached = this.listings.get(dir);
    if (cached && performance.now() - cached.loadedAt < maxAge) return Promise.resolve();
    return this.fetch(dir);
  }

  prefetch(dir: string): void {
    if (this.listings.has(dir) || this.requests.has(dir) || this.fs.closed) return;
    void this.fetch(dir);
  }

  private fetch(dir: string): Promise<void> {
    const ticket = ++this.tickets;
    const promise = this.fs.list(dir).then(
      (entries) => this.settle(dir, ticket, entries.sort(compareEntries), undefined),
      (error: unknown) => this.settle(dir, ticket, undefined, describeError(error).message),
    );
    this.requests.set(dir, { ticket, promise });
    return promise;
  }

  private settle(
    dir: string,
    ticket: number,
    entries: Entry[] | undefined,
    error: string | undefined,
  ): void {
    if (this.requests.get(dir)?.ticket !== ticket) return;
    this.requests.delete(dir);
    const previous = this.listings.get(dir)?.entries;
    const kept = entries && previous && sameEntries(previous, entries) ? previous : entries;
    this.listings.delete(dir);
    this.listings.set(dir, {
      entries: kept ?? previous,
      error,
      revision: ticket,
      loadedAt: performance.now(),
    });
    this.evict();
    for (const listener of [...(this.listeners.get(dir) ?? [])]) listener();
  }

  private evict(): void {
    for (const dir of this.listings.keys()) {
      if (this.listings.size <= MAX_CACHED_DIRS) return;
      if (!this.listeners.has(dir)) this.listings.delete(dir);
    }
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
