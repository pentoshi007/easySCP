import { closeSync, rmSync } from 'node:fs';
import { type FileHandle, mkdir, mkdtemp, open, readdir, rm, statfs } from 'node:fs/promises';
import type { PlatformPath } from 'node:path';
import { join } from 'node:path';
import { AppError } from '../core/errors.js';
import { cacheDir } from '../core/paths.js';
import type { Entry, FileSystem, Reader, ScanEntry, Writer } from '../fs/types.js';
import { Semaphore } from '../util/concurrency.js';

const RESERVED_SPACE = 1024 ** 3;
const FETCH_CONCURRENCY = 32;
const DISCARD_GRACE = 2000;

export interface StageUsage {
  fetched: number;
  direct: number;
  stored: number;
}

interface PositionalSource {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number>;
}

async function readExact(
  source: PositionalSource,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<void> {
  let filled = 0;
  while (filled < length) {
    const count = await source.read(buffer, offset + filled, length - filled, position + filled);
    if (count === 0) throw new AppError('The file changed size while it was being copied');
    filled += count;
  }
}

function diskSource(handle: FileHandle): PositionalSource {
  return {
    read: async (buffer, offset, length, position) =>
      (await handle.read(buffer, offset, length, position)).bytesRead,
  };
}

async function writeExact(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      written,
      buffer.length - written,
      position + written,
    );
    written += bytesWritten;
  }
}

function settleWithin(tasks: Promise<unknown>[], ms: number): Promise<void> {
  if (tasks.length === 0) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.allSettled(tasks).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

function discardedError(): Error {
  return new AppError('The relay cache was already cleaned up');
}

class StagedFile {
  readonly ready: Uint8Array;
  readonly pending = new Map<number, Promise<Buffer>>();
  readonly writes = new Set<Promise<void>>();
  stored = 0;
  discarded = false;
  private disk: Promise<FileHandle> | undefined;
  private fd: number | undefined;
  private reader: Promise<Reader> | undefined;

  constructor(
    readonly entry: Entry,
    blockSize: number,
    private readonly file: string,
    public staging: boolean,
  ) {
    this.ready = new Uint8Array(staging ? Math.ceil(entry.size / blockSize) : 0);
  }

  handle(): Promise<FileHandle> {
    if (this.discarded) return Promise.reject(discardedError());
    this.disk ??= open(this.file, 'w+', 0o600).then((handle) => {
      this.fd = handle.fd;
      return handle;
    });
    return this.disk;
  }

  source(fs: FileSystem): Promise<Reader> {
    if (this.discarded) return Promise.reject(discardedError());
    if (!this.reader) {
      const opening = fs.openRead(this.entry.path);
      this.reader = opening;
      opening.catch(() => {
        if (this.reader === opening) this.reader = undefined;
      });
    }
    return this.reader;
  }

  reset(): void {
    const reader = this.reader;
    this.reader = undefined;
    reader?.then((open) => open.close()).catch(() => undefined);
  }

  async discard(): Promise<void> {
    this.discarded = true;
    this.staging = false;
    await settleWithin([...this.writes], DISCARD_GRACE);
    this.reset();
    const disk = this.disk;
    this.disk = undefined;
    this.fd = undefined;
    if (!disk) return;
    await disk.then((handle) => handle.close()).catch(() => undefined);
    await rm(this.file, { force: true }).catch(() => undefined);
  }

  closeSync(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd === undefined) return;
    try {
      closeSync(fd);
    } catch {}
  }
}

export class Stage implements FileSystem {
  readonly local: boolean;
  readonly label: string;
  readonly path: PlatformPath;
  readonly home: string;
  readonly chunkSize: number;
  readonly parallelChunks: number;
  private readonly blockSize: number;
  private readonly files = new Map<string, StagedFile>();
  private readonly entries = new Map<string, Promise<Entry | undefined>>();
  private readonly listings = new Map<string, Promise<Entry[]>>();
  private readonly consumers = new Map<string, number>();
  private readonly fetches = new Semaphore(FETCH_CONCURRENCY);
  private readonly usage: StageUsage = { fetched: 0, direct: 0, stored: 0 };
  private readonly cleanup = () => {
    for (const file of this.files.values()) file.closeSync();
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {}
  };
  private counter = 0;
  private finished = false;

  constructor(
    private source: FileSystem,
    readonly dir: string,
    readonly budget: number,
  ) {
    this.local = source.local;
    this.label = source.label;
    this.path = source.path;
    this.home = source.home;
    this.chunkSize = source.chunkSize;
    this.parallelChunks = source.parallelChunks;
    this.blockSize = source.chunkSize;
    if (dir) process.once('exit', this.cleanup);
  }

  get closed(): boolean {
    return this.source.closed;
  }

  get stats(): StageUsage {
    return { ...this.usage };
  }

  replaceSource(source: FileSystem): void {
    this.source = source;
    for (const file of this.files.values()) file.reset();
  }

  roots(): Promise<string[]> {
    return this.source.roots();
  }

  stat(target: string): Promise<Entry | undefined> {
    return this.remember(this.entries, target, () => this.source.stat(target));
  }

  list(dir: string): Promise<Entry[]> {
    return this.remember(this.listings, dir, async () => {
      const entries = await this.source.list(dir);
      for (const entry of entries) {
        if (!this.entries.has(entry.path)) this.entries.set(entry.path, Promise.resolve(entry));
      }
      return entries;
    });
  }

  scan(dir: string): Promise<ScanEntry[]> {
    return this.source.scan(dir);
  }

  async mkdir(): Promise<void> {
    this.readOnly();
  }

  async rename(): Promise<void> {
    this.readOnly();
  }

  async removeFile(): Promise<void> {
    this.readOnly();
  }

  async removeDir(): Promise<void> {
    this.readOnly();
  }

  async openWrite(): Promise<Writer> {
    this.readOnly();
  }

  async openRead(file: string): Promise<Reader> {
    const staged = await this.staged(file);
    return {
      read: (buffer, offset, length, position) =>
        this.read(staged, buffer, offset, length, position),
      close: async () => undefined,
    };
  }

  expect(file: string): void {
    this.consumers.set(file, (this.consumers.get(file) ?? 0) + 1);
  }

  async release(file: string): Promise<void> {
    const left = (this.consumers.get(file) ?? 0) - 1;
    if (left > 0) {
      this.consumers.set(file, left);
      return;
    }
    this.consumers.delete(file);
    const staged = this.files.get(file);
    if (!staged) return;
    this.files.delete(file);
    await this.evict(staged);
  }

  async close(): Promise<void> {
    this.finished = true;
    const files = [...this.files.values()];
    try {
      await Promise.all(files.map((file) => this.evict(file)));
    } finally {
      this.files.clear();
      if (this.dir) {
        await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
        process.off('exit', this.cleanup);
      }
    }
  }

  private readOnly(): never {
    throw new AppError('The relay cache is read-only');
  }

  private remember<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) {
    let pending = cache.get(key);
    if (!pending) {
      pending = load();
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    return pending;
  }

  private async staged(file: string): Promise<StagedFile> {
    const known = this.files.get(file);
    if (known) return known;
    const entry = await this.stat(file);
    if (entry?.kind !== 'file') {
      throw Object.assign(new Error(`No such file: ${file}`), { code: 'ENOENT' });
    }
    const raced = this.files.get(file);
    if (raced) return raced;
    const shared = (this.consumers.get(file) ?? 0) > 1;
    const created = new StagedFile(
      entry,
      this.blockSize,
      join(this.dir, String(++this.counter)),
      shared && !this.finished && this.dir !== '' && this.budget > 0,
    );
    this.files.set(file, created);
    return created;
  }

  private async evict(file: StagedFile): Promise<void> {
    const discarding = file.discard();
    this.usage.stored -= file.stored;
    file.stored = 0;
    await discarding;
  }

  private async read(
    file: StagedFile,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    const end = Math.min(position + length, file.entry.size);
    if (end <= position) return 0;
    const first = Math.floor(position / this.blockSize);
    const last = Math.floor((end - 1) / this.blockSize);
    this.prefetch(file, last + 1);
    const parts: Promise<void>[] = [];
    for (let index = first; index <= last; index++) {
      const start = index * this.blockSize;
      const from = Math.max(position, start);
      const to = Math.min(end, start + this.blockSize);
      parts.push(this.copyBlock(file, index, buffer, offset + from - position, from, to));
    }
    await Promise.all(parts);
    return end - position;
  }

  private async copyBlock(
    file: StagedFile,
    index: number,
    buffer: Buffer,
    at: number,
    from: number,
    to: number,
  ): Promise<void> {
    if (file.ready[index]) {
      await readExact(diskSource(await file.handle()), buffer, at, to - from, from);
      return;
    }
    const pending = file.pending.get(index) ?? this.fetch(file, index);
    if (pending) {
      const start = index * this.blockSize;
      (await pending).copy(buffer, at, from - start, to - start);
      return;
    }
    await readExact(await file.source(this.source), buffer, at, to - from, from);
    this.usage.fetched += to - from;
    this.usage.direct += to - from;
  }

  private prefetch(file: StagedFile, from: number): void {
    const until = Math.min(file.ready.length, from + this.parallelChunks);
    for (let index = from; index < until; index++) {
      if (file.ready[index] || file.pending.has(index)) continue;
      if (!this.fetch(file, index)) return;
    }
  }

  private fetch(file: StagedFile, index: number): Promise<Buffer> | undefined {
    const start = index * this.blockSize;
    const length = Math.min(this.blockSize, file.entry.size - start);
    if (!file.staging || this.usage.stored + length > this.budget) return undefined;
    this.usage.stored += length;
    file.stored += length;
    const unstore = () => {
      if (file.discarded) return;
      this.usage.stored -= length;
      file.stored -= length;
    };
    const data = this.fetches.run(async () => {
      const buffer = Buffer.allocUnsafe(length);
      await readExact(await file.source(this.source), buffer, 0, length, start);
      this.usage.fetched += length;
      return buffer;
    });
    file.pending.set(index, data);
    const write: Promise<void> = data
      .then(async (buffer) => {
        try {
          await writeExact(await file.handle(), buffer, start);
          file.ready[index] = 1;
        } catch {
          file.staging = false;
          unstore();
        }
      }, unstore)
      .finally(() => {
        file.pending.delete(index);
        file.writes.delete(write);
      });
    file.writes.add(write);
    return data;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function sweep(root: string): Promise<void> {
  const names = await readdir(root).catch(() => []);
  await Promise.all(
    names.map(async (name) => {
      const pid = Number.parseInt(name, 10);
      if (pid === process.pid || (pid > 0 && alive(pid))) return;
      await rm(join(root, name), { recursive: true, force: true }).catch(() => undefined);
    }),
  );
}

async function freeSpace(dir: string): Promise<number> {
  try {
    const stats = await statfs(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return 0;
  }
}

export interface StageOptions {
  root?: string;
  budget?: number;
}

export function passThrough(source: FileSystem): Stage {
  return new Stage(source, '', 0);
}

export async function createStage(source: FileSystem, options: StageOptions = {}): Promise<Stage> {
  const root = options.root ?? join(cacheDir(), 'relay');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await sweep(root);
  const dir = await mkdtemp(join(root, `${process.pid}-`));
  const free = options.budget === undefined ? await freeSpace(dir) : 0;
  const budget = options.budget ?? Math.max(0, free - Math.max(RESERVED_SPACE, free * 0.1));
  return new Stage(source, dir, budget);
}
