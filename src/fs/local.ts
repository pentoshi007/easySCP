import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapLimit } from '../util/concurrency.js';
import type { Attributes, Entry, FileSystem, Reader, ScanEntry, Writer } from './types.js';

const WINDOWS = process.platform === 'win32';

function kindOf(stats: Stats): Entry['kind'] {
  if (stats.isDirectory()) return 'dir';
  if (stats.isFile()) return 'file';
  return 'other';
}

async function describe(target: string, name: string): Promise<Entry | undefined> {
  let stats: Stats;
  try {
    stats = await fs.lstat(target);
  } catch {
    return undefined;
  }
  const link = stats.isSymbolicLink();
  if (link) {
    try {
      stats = await fs.stat(target);
    } catch {
      return { name, path: target, kind: 'other', link, size: 0, mtime: stats.mtimeMs, mode: 0 };
    }
  }
  return {
    name,
    path: target,
    kind: kindOf(stats),
    link,
    size: stats.size,
    mtime: Math.floor(stats.mtimeMs),
    mode: stats.mode & 0o7777,
  };
}

class LocalReader implements Reader {
  constructor(private readonly handle: fs.FileHandle) {}

  async read(buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
    const { bytesRead } = await this.handle.read(buffer, offset, length, position);
    return bytesRead;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

class LocalWriter implements Writer {
  constructor(private readonly handle: fs.FileHandle) {}

  async write(buffer: Buffer, offset: number, length: number, position: number): Promise<void> {
    let written = 0;
    while (written < length) {
      const { bytesWritten } = await this.handle.write(
        buffer,
        offset + written,
        length - written,
        position + written,
      );
      written += bytesWritten;
    }
  }

  async finish({ mode, mtime }: Attributes): Promise<void> {
    if (mode !== undefined && !WINDOWS) await this.handle.chmod(mode & 0o7777).catch(() => {});
    if (mtime !== undefined) {
      const seconds = mtime / 1000;
      await this.handle.utimes(seconds, seconds).catch(() => {});
    }
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

export class LocalFileSystem implements FileSystem {
  readonly local = true;
  readonly label = 'this computer';
  readonly path = path;
  readonly home = os.homedir();
  readonly chunkSize = 256 * 1024;
  readonly parallelChunks = 4;

  async roots(): Promise<string[]> {
    if (!WINDOWS) return ['/'];
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
    const found = await Promise.all(
      letters.map((letter) =>
        fs.access(`${letter}:\\`).then(
          () => `${letter}:\\`,
          () => undefined,
        ),
      ),
    );
    return found.filter((root) => root !== undefined);
  }

  stat(target: string): Promise<Entry | undefined> {
    return describe(target, path.basename(target) || target);
  }

  async list(dir: string): Promise<Entry[]> {
    const names = await fs.readdir(dir);
    const entries = await mapLimit(names, 64, (name) => describe(path.join(dir, name), name));
    return entries.filter((entry) => entry !== undefined);
  }

  async scan(dir: string): Promise<ScanEntry[]> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    return dirents.map((dirent) => ({ name: dirent.name, dir: dirent.isDirectory() }));
  }

  async mkdir(dir: string): Promise<void> {
    await fs.mkdir(dir);
  }

  async rename(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!WINDOWS || attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
  }

  removeFile(target: string): Promise<void> {
    return fs.unlink(target);
  }

  removeDir(target: string): Promise<void> {
    return fs.rmdir(target);
  }

  async openRead(file: string): Promise<Reader> {
    return new LocalReader(await fs.open(file, 'r'));
  }

  async openWrite(file: string, append: boolean): Promise<Writer> {
    return new LocalWriter(await fs.open(file, append ? 'r+' : 'w', 0o644));
  }
}

export const localFs = new LocalFileSystem();
