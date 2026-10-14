import path from 'node:path';
import type { SFTPWrapper, Attributes as SftpAttributes } from 'ssh2';
import type { Session } from '../ssh/session.js';
import { mapLimit } from '../util/concurrency.js';
import type { Attributes, Entry, FileSystem, Reader, ScanEntry, Writer } from './types.js';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const SFTP_ERRNO: Record<number, string> = {
  2: 'ENOENT',
  3: 'EACCES',
  8: 'ENOTSUP',
};

const SFTP_EOF = 1;

interface DirItem {
  filename: string;
  attrs: SftpAttributes;
}

const SAFE_PACKET = 31 * 1024;
const IN_FLIGHT_BYTES = 2 * 1024 * 1024;

function sftpError(error: Error & { code?: number | string }, target: string): Error {
  const errno = typeof error.code === 'number' ? SFTP_ERRNO[error.code] : undefined;
  if (!errno) {
    return Object.assign(new Error(`${error.message || 'Remote operation failed'}: ${target}`), {
      cause: error,
    });
  }
  return Object.assign(new Error(`${error.message}: ${target}`), { code: errno, path: target });
}

function kindOf(mode: number): Entry['kind'] {
  const type = mode & S_IFMT;
  if (type === S_IFDIR) return 'dir';
  if (type === S_IFREG) return 'file';
  return 'other';
}

function toEntry(name: string, target: string, attrs: SftpAttributes, link: boolean): Entry {
  return {
    name,
    path: target,
    kind: kindOf(attrs.mode),
    link,
    size: attrs.size ?? 0,
    mtime: (attrs.mtime ?? 0) * 1000,
    mode: attrs.mode & 0o7777,
  };
}

function packetLimit(sftp: SFTPWrapper): number {
  const limits = sftp as unknown as { _maxReadLen?: unknown; _maxWriteLen?: unknown };
  const read = typeof limits._maxReadLen === 'number' ? limits._maxReadLen : SAFE_PACKET;
  const write = typeof limits._maxWriteLen === 'number' ? limits._maxWriteLen : SAFE_PACKET;
  return Math.max(SAFE_PACKET, Math.min(read, write, 255 * 1024));
}

type Run<T> = (done: (error?: Error | null, value?: T) => void) => void;

function connectionLost(session: Session, target: string): Error {
  return Object.assign(new Error(`Connection to ${session.host.name} was lost: ${target}`), {
    code: 'ECONNRESET',
  });
}

function call<T>(session: Session, target: string, run: Run<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (session.closed) {
      reject(connectionLost(session, target));
      return;
    }
    run((error, value) => (error ? reject(sftpError(error, target)) : resolve(value as T)));
  });
}

class RemoteReader implements Reader {
  private readonly sftp: SFTPWrapper;

  constructor(
    private readonly session: Session,
    private readonly handle: Buffer,
    private readonly file: string,
  ) {
    this.sftp = session.sftp;
  }

  read(buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
    return call<number>(this.session, this.file, (done) =>
      this.sftp.read(this.handle, buffer, offset, length, position, (error, bytesRead) =>
        done(error, bytesRead),
      ),
    );
  }

  close(): Promise<void> {
    return call<void>(this.session, this.file, (done) => this.sftp.close(this.handle, done));
  }
}

class RemoteWriter implements Writer {
  private readonly sftp: SFTPWrapper;

  constructor(
    private readonly session: Session,
    private readonly handle: Buffer,
    private readonly file: string,
  ) {
    this.sftp = session.sftp;
  }

  write(buffer: Buffer, offset: number, length: number, position: number): Promise<void> {
    return call<void>(this.session, this.file, (done) =>
      this.sftp.write(this.handle, buffer, offset, length, position, done),
    );
  }

  async finish({ mode, mtime }: Attributes): Promise<void> {
    const attrs: Record<string, number> = {};
    if (mode !== undefined) attrs.mode = mode & 0o7777;
    if (mtime !== undefined) {
      attrs.mtime = Math.floor(mtime / 1000);
      attrs.atime = attrs.mtime;
    }
    if (Object.keys(attrs).length === 0) return;
    await call<void>(this.session, this.file, (done) =>
      this.sftp.fsetstat(this.handle, attrs, done),
    ).catch(() => undefined);
  }

  close(): Promise<void> {
    return call<void>(this.session, this.file, (done) => this.sftp.close(this.handle, done));
  }
}

export class RemoteFileSystem implements FileSystem {
  readonly local = false;
  readonly path = path.posix;
  readonly label: string;
  readonly home: string;
  readonly chunkSize: number;
  readonly parallelChunks: number;
  private readonly sftp: SFTPWrapper;

  constructor(readonly session: Session) {
    this.sftp = session.sftp;
    this.label = session.host.name;
    this.home = session.home;
    this.chunkSize = packetLimit(this.sftp);
    this.parallelChunks = Math.max(8, Math.floor(IN_FLIGHT_BYTES / this.chunkSize));
  }

  get closed(): boolean {
    return this.session.closed;
  }

  async roots(): Promise<string[]> {
    return ['/'];
  }

  async stat(target: string): Promise<Entry | undefined> {
    const name = path.posix.basename(target) || target;
    let attrs: SftpAttributes;
    try {
      attrs = await call<SftpAttributes>(this.session, target, (done) =>
        this.sftp.lstat(target, done),
      );
    } catch {
      return undefined;
    }
    if ((attrs.mode & S_IFMT) !== S_IFLNK) return toEntry(name, target, attrs, false);
    try {
      const resolved = await call<SftpAttributes>(this.session, target, (done) =>
        this.sftp.stat(target, done),
      );
      return toEntry(name, target, resolved, true);
    } catch {
      return { ...toEntry(name, target, attrs, true), kind: 'other' };
    }
  }

  private readDir(dir: string): Promise<DirItem[]> {
    return call<DirItem[]>(this.session, dir, (done) =>
      this.sftp.opendir(dir, (error, handle) => {
        if (error) {
          done(error);
          return;
        }
        const items: DirItem[] = [];
        const release = () => {
          try {
            this.sftp.close(handle, () => undefined);
          } catch {}
        };
        const next = () => {
          this.sftp.readdir(handle, (failure, list) => {
            if (failure) {
              release();
              if ((failure as Error & { code?: unknown }).code === SFTP_EOF) done(null, items);
              else done(failure);
              return;
            }
            for (const item of list) {
              if (item.filename !== '.' && item.filename !== '..') items.push(item);
            }
            next();
          });
        };
        next();
      }),
    );
  }

  async list(dir: string): Promise<Entry[]> {
    const items = await this.readDir(dir);
    return mapLimit(items, 32, async ({ filename, attrs }) => {
      const target = path.posix.join(dir, filename);
      if ((attrs.mode & S_IFMT) !== S_IFLNK) return toEntry(filename, target, attrs, false);
      const resolved = await this.stat(target);
      return resolved ?? { ...toEntry(filename, target, attrs, true), kind: 'other' as const };
    });
  }

  async scan(dir: string): Promise<ScanEntry[]> {
    const items = await this.readDir(dir);
    return items.map(({ filename, attrs }) => ({
      name: filename,
      dir: (attrs.mode & S_IFMT) === S_IFDIR,
    }));
  }

  mkdir(dir: string): Promise<void> {
    return call<void>(this.session, dir, (done) => this.sftp.mkdir(dir, done));
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await call<void>(this.session, to, (done) => this.sftp.ext_openssh_rename(from, to, done));
      return;
    } catch (error) {
      if (!/does not support/i.test((error as Error).message)) throw error;
    }
    const move = (source: string, destination: string) =>
      call<void>(this.session, destination, (done) => this.sftp.rename(source, destination, done));
    try {
      await move(from, to);
    } catch (error) {
      const existing = await this.stat(to);
      if (!existing || existing.kind === 'dir') throw error;
      const backup = this.path.join(
        this.path.dirname(to),
        `.${this.path.basename(to)}.easyscp-old`,
      );
      await move(to, backup);
      try {
        await move(from, to);
      } catch (failure) {
        await move(backup, to).catch(() => undefined);
        throw failure;
      }
      await this.removeFile(backup).catch(() => undefined);
    }
  }

  removeFile(target: string): Promise<void> {
    return call<void>(this.session, target, (done) => this.sftp.unlink(target, done));
  }

  removeDir(target: string): Promise<void> {
    return call<void>(this.session, target, (done) => this.sftp.rmdir(target, done));
  }

  async openRead(file: string): Promise<Reader> {
    const handle = await call<Buffer>(this.session, file, (done) =>
      this.sftp.open(file, 'r', done),
    );
    return new RemoteReader(this.session, handle, file);
  }

  async openWrite(file: string, append: boolean): Promise<Writer> {
    const flags = append ? 'r+' : 'w';
    const handle = await call<Buffer>(this.session, file, (done) =>
      this.sftp.open(file, flags, { mode: 0o644 }, done),
    );
    return new RemoteWriter(this.session, handle, file);
  }
}
