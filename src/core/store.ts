import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from './errors.js';

const PRIVATE_FILE = 0o600;
const PRIVATE_DIR = 0o700;

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, data, { mode: PRIVATE_FILE });
  try {
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= 5) throw error;
      await sleep(20 * 2 ** attempt);
    }
  }
}

export interface JsonStoreOptions<T> {
  file: () => string;
  defaults: () => T;
  normalize: (raw: unknown) => T;
  strict?: boolean;
}

export class JsonStore<T> {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: JsonStoreOptions<T>) {}

  get file(): string {
    return this.options.file();
  }

  async read(): Promise<T> {
    const text = await readText(this.file);
    if (text === undefined || text.trim() === '') return this.options.defaults();
    try {
      return this.options.normalize(JSON.parse(text));
    } catch (error) {
      if (this.options.strict) {
        throw new AppError(
          `Could not read ${this.file}: ${(error as Error).message}`,
          'Fix the file by hand or delete it to start fresh.',
        );
      }
      return this.options.defaults();
    }
  }

  async write(value: T): Promise<void> {
    await this.serialize(() => writeFileAtomic(this.file, `${JSON.stringify(value, null, 2)}\n`));
  }

  update(mutate: (value: T) => T | undefined): Promise<T> {
    return this.serialize(async () => {
      const current = await this.read();
      const next = mutate(current) ?? current;
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    });
  }

  private serialize<R>(task: () => Promise<R>): Promise<R> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
