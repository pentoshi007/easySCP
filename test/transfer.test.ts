import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHost } from '../src/core/hosts.js';
import { setSecret } from '../src/core/secrets.js';
import { localFs } from '../src/fs/local.js';
import { partName } from '../src/fs/names.js';
import { RemoteFileSystem } from '../src/fs/remote.js';
import type { FileSystem, Writer } from '../src/fs/types.js';
import { Session } from '../src/ssh/session.js';
import { listHistory, recordTransfer } from '../src/transfer/history.js';
import { SpeedMeter } from '../src/transfer/meter.js';
import { planTransfer, type TransferSpec } from '../src/transfer/plan.js';
import { type RunOptions, runTransfer, type TransferProgress } from '../src/transfer/run.js';
import { isolatedEnvironment } from './helpers/env.js';
import { scripted } from './helpers/interaction.js';
import { startTestServer, type TestServer } from './helpers/sftpServer.js';
import { tempDir } from './helpers/tmp.js';

function tripwire(fs: FileSystem, trigger: () => void): FileSystem {
  let fired = false;
  const openWrite = async (file: string, append: boolean): Promise<Writer> => {
    const writer = await fs.openWrite(file, append);
    return {
      finish: (attributes) => writer.finish(attributes),
      close: () => writer.close(),
      write: async (...args) => {
        await writer.write(...args);
        if (!fired) {
          fired = true;
          trigger();
        }
      },
    };
  };
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'openWrite') return openWrite;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

let server: TestServer;
let session: Session;
let remote: RemoteFileSystem;
let remoteRoot: string;
let local: string;

const real = (...parts: string[]) => path.join(remoteRoot, 'home', 'test', ...parts);
const remotePath = (...parts: string[]) => path.posix.join('/home/test', ...parts);

async function connectSession() {
  const host = await createHost({
    name: `t${Math.random().toString(36).slice(2, 8)}`,
    hostname: '127.0.0.1',
    port: server.port,
    user: 'u',
    auth: 'password',
  });
  await setSecret(host.id, 'password', 'p');
  return Session.open(host, { interaction: scripted() });
}

async function transfer(
  spec: Omit<TransferSpec, 'source' | 'target'> & { up?: boolean },
  run: RunOptions = {},
) {
  const up = spec.up ?? true;
  const plan = await planTransfer({
    source: up ? localFs : remote,
    target: up ? remote : localFs,
    sources: spec.sources,
    destination: spec.destination,
  });
  return { plan, result: await runTransfer(plan, run) };
}

beforeAll(async () => {
  await isolatedEnvironment();
  remoteRoot = await tempDir();
  server = await startTestServer({ root: remoteRoot, users: [{ username: 'u', password: 'p' }] });
  session = await connectSession();
  remote = new RemoteFileSystem(session);
});

afterAll(async () => {
  session?.close();
  await server?.close();
});

beforeEach(async () => {
  local = await tempDir();
});

describe('upload', () => {
  it('copies a file into an existing folder and preserves mtime', async () => {
    await mkdir(real('inbox'), { recursive: true });
    await writeFile(path.join(local, 'a.txt'), 'alpha');
    await utimes(path.join(local, 'a.txt'), 1_650_000_000, 1_650_000_000);

    const { plan, result } = await transfer({
      sources: [path.join(local, 'a.txt')],
      destination: remotePath('inbox'),
    });
    expect(plan.files.map((file) => file.target)).toEqual([remotePath('inbox', 'a.txt')]);
    expect(result).toMatchObject({ status: 'done', files: 1, bytes: 5 });
    expect(await readFile(real('inbox', 'a.txt'), 'utf8')).toBe('alpha');
    expect((await stat(real('inbox', 'a.txt'))).mtimeMs).toBe(1_650_000_000_000);
    expect(await readdir(real('inbox'))).toEqual(['a.txt']);
  });

  it('copies a single file under a new name when the destination does not exist', async () => {
    await writeFile(path.join(local, 'report.pdf'), 'pdf');
    await transfer({
      sources: [path.join(local, 'report.pdf')],
      destination: remotePath('new', 'final.pdf'),
    });
    expect(await readFile(real('new', 'final.pdf'), 'utf8')).toBe('pdf');
  });

  it('treats a trailing slash as a folder', async () => {
    await writeFile(path.join(local, 'x.txt'), 'x');
    await transfer({
      sources: [path.join(local, 'x.txt')],
      destination: `${remotePath('slash')}/`,
    });
    expect(await readFile(real('slash', 'x.txt'), 'utf8')).toBe('x');
  });

  it('copies whole trees including empty folders', async () => {
    const tree = path.join(local, 'project');
    await mkdir(path.join(tree, 'src', 'lib'), { recursive: true });
    await mkdir(path.join(tree, 'empty'), { recursive: true });
    await writeFile(path.join(tree, 'src', 'main.ts'), 'main');
    await writeFile(path.join(tree, 'src', 'lib', 'util.ts'), 'util');
    await writeFile(path.join(tree, 'README'), 'readme');

    await mkdir(real('deploy'));
    const { plan, result } = await transfer({ sources: [tree], destination: remotePath('deploy') });
    expect(plan.files.map((file) => file.relative)).toEqual([
      'project/README',
      'project/src/lib/util.ts',
      'project/src/main.ts',
    ]);
    expect(result.status).toBe('done');
    expect(await readFile(real('deploy', 'project', 'src', 'lib', 'util.ts'), 'utf8')).toBe('util');
    expect((await stat(real('deploy', 'project', 'empty'))).isDirectory()).toBe(true);
  });

  it('streams large files intact with pipelining', async () => {
    const data = randomBytes(5 * 1024 * 1024 + 123);
    await writeFile(path.join(local, 'big.bin'), data);
    const progress: TransferProgress[] = [];
    const { result } = await transfer(
      { sources: [path.join(local, 'big.bin')], destination: remotePath() },
      { onProgress: (update) => progress.push(update) },
    );
    expect(result.bytes).toBe(data.length);
    expect(sha(await readFile(real('big.bin')))).toBe(sha(data));
    expect(progress.at(-1)).toMatchObject({ doneBytes: data.length, doneFiles: 1, active: [] });
  });
});

describe('conflicts', () => {
  beforeEach(async () => {
    await mkdir(real('c'), { recursive: true });
    await writeFile(real('c', 'same.txt'), 'old');
    await utimes(real('c', 'same.txt'), 1_600_000_000, 1_600_000_000);
    await writeFile(path.join(local, 'same.txt'), 'new!');
    await utimes(path.join(local, 'same.txt'), 1_700_000_000, 1_700_000_000);
  });

  const run = (policy: RunOptions['policy']) =>
    transfer({ sources: [path.join(local, 'same.txt')], destination: remotePath('c') }, { policy });

  it('reports conflicts and skips by default', async () => {
    const { plan, result } = await run(undefined);
    expect(plan.conflicts).toHaveLength(1);
    expect(result).toMatchObject({ status: 'done', files: 0, skipped: 1 });
    expect(await readFile(real('c', 'same.txt'), 'utf8')).toBe('old');
  });

  it('overwrites atomically even without posix-rename', async () => {
    await run('overwrite');
    expect(await readFile(real('c', 'same.txt'), 'utf8')).toBe('new!');
    expect(await readdir(real('c'))).toEqual(['same.txt']);
  });

  it('keeps both files when renaming', async () => {
    await run('rename');
    expect((await readdir(real('c'))).sort()).toEqual(['same (1).txt', 'same.txt']);
  });

  it('only replaces older files with newer', async () => {
    await run('newer');
    expect(await readFile(real('c', 'same.txt'), 'utf8')).toBe('new!');
    await utimes(path.join(local, 'same.txt'), 1_500_000_000, 1_500_000_000);
    const { result } = await run('newer');
    expect(result.skipped).toBe(1);
  });

  it('skips folders that collide with files and vice versa', async () => {
    await mkdir(path.join(local, 'dir', 'same.txt'), { recursive: true });
    await writeFile(path.join(local, 'dir', 'same.txt', 'inner'), 'i');
    const { plan } = await transfer({
      sources: [path.join(local, 'dir', 'same.txt')],
      destination: remotePath('c'),
    });
    expect(plan.files).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toMatch(/file with the same name/);
  });

  it('skips duplicate names across selections', async () => {
    await mkdir(path.join(local, 'other'));
    await writeFile(path.join(local, 'other', 'same.txt'), 'dup');
    const { plan } = await transfer({
      sources: [path.join(local, 'same.txt'), path.join(local, 'other', 'same.txt')],
      destination: remotePath('c'),
    });
    expect(plan.files).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toMatch(/same name/);
  });
});

describe('download', () => {
  it('downloads trees from the server', async () => {
    await mkdir(real('logs', 'nested'), { recursive: true });
    await writeFile(real('logs', 'app.log'), 'log');
    await writeFile(real('logs', 'nested', 'deep.log'), 'deep');
    const { result } = await transfer({
      up: false,
      sources: [remotePath('logs')],
      destination: local,
    });
    expect(result.status).toBe('done');
    expect(await readFile(path.join(local, 'logs', 'nested', 'deep.log'), 'utf8')).toBe('deep');
  });
});

describe('resume', () => {
  it('continues from a matching partial file', async () => {
    const data = randomBytes(9 * 1024 * 1024);
    await writeFile(real('resume.bin'), data);
    await writeFile(path.join(local, partName('resume.bin')), data.subarray(0, 6 * 1024 * 1024));

    const { plan, result } = await transfer({
      up: false,
      sources: [remotePath('resume.bin')],
      destination: local,
    });
    expect(plan.files[0]?.partial).toBe(6 * 1024 * 1024);
    expect(result.bytes).toBe(7 * 1024 * 1024);
    expect(sha(await readFile(path.join(local, 'resume.bin')))).toBe(sha(data));
    expect(await readdir(local)).toEqual(['resume.bin']);
  });

  it('rewrites the tail of a partial file in case later chunks landed first', async () => {
    const data = randomBytes(8 * 1024 * 1024);
    const holey = Buffer.from(data.subarray(0, 7 * 1024 * 1024));
    holey.fill(0, 5 * 1024 * 1024, 6 * 1024 * 1024);
    await writeFile(real('holey.bin'), data);
    await writeFile(path.join(local, partName('holey.bin')), holey);
    await transfer({ up: false, sources: [remotePath('holey.bin')], destination: local });
    expect(sha(await readFile(path.join(local, 'holey.bin')))).toBe(sha(data));
  });

  it('restarts when the partial file does not match', async () => {
    const data = randomBytes(256 * 1024);
    await writeFile(real('mismatch.bin'), data);
    await writeFile(path.join(local, partName('mismatch.bin')), randomBytes(1024));
    const { result } = await transfer({
      up: false,
      sources: [remotePath('mismatch.bin')],
      destination: local,
    });
    expect(result.bytes).toBe(data.length);
    expect(sha(await readFile(path.join(local, 'mismatch.bin')))).toBe(sha(data));
  });

  it('appends to a shorter existing file with the resume policy', async () => {
    const data = randomBytes(6 * 1024 * 1024);
    await writeFile(path.join(local, 'append.bin'), data);
    await writeFile(real('append.bin'), data.subarray(0, 5_000_000));
    const { result } = await transfer(
      { sources: [path.join(local, 'append.bin')], destination: remotePath() },
      { policy: 'resume' },
    );
    expect(result.bytes).toBe(data.length - (5_000_000 - 4 * 1024 * 1024));
    expect(sha(await readFile(real('append.bin')))).toBe(sha(data));
  });
});

describe('cancellation and failures', () => {
  it('cancels promptly and cleans up small partial files', async () => {
    await writeFile(path.join(local, 'slow.bin'), randomBytes(4 * 1024 * 1024));
    const controller = new AbortController();
    const plan = await planTransfer({
      source: localFs,
      target: tripwire(remote, () => controller.abort()),
      sources: [path.join(local, 'slow.bin')],
      destination: `${remotePath('cancel')}/`,
    });
    const result = await runTransfer(plan, { signal: controller.signal });
    expect(result.status).toBe('cancelled');
    expect(result.files).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readdir(real('cancel'))).toEqual([]);
  });

  it('reports a lost connection as fatal', async () => {
    const own = await connectSession();
    const fs = new RemoteFileSystem(own);
    await writeFile(path.join(local, 'lost.bin'), randomBytes(8 * 1024 * 1024));
    const plan = await planTransfer({
      source: localFs,
      target: tripwire(fs, () => own.client.destroy()),
      sources: [path.join(local, 'lost.bin')],
      destination: `${remotePath('lost')}/`,
    });
    const result = await runTransfer(plan);
    expect(result.status).toBe('failed');
    expect(result.error?.message).toMatch(/lost/);
    expect(result.error?.hint).toMatch(/resume/);
  });

  it('collects per-file failures and continues', async () => {
    await mkdir(real('partial', partName('b.txt')), { recursive: true });
    await writeFile(path.join(local, 'a.txt'), 'a');
    await writeFile(path.join(local, 'b.txt'), 'b');
    const { result } = await transfer({
      sources: [path.join(local, 'a.txt'), path.join(local, 'b.txt')],
      destination: remotePath('partial'),
    });
    expect(result.status).toBe('partial');
    expect(result.files).toBe(1);
    expect(result.failed.map((failure) => failure.path)).toEqual(['b.txt']);
    expect(await readFile(real('partial', 'a.txt'), 'utf8')).toBe('a');
  });
});

describe('meter and history', () => {
  it('computes speed over a sliding window', () => {
    let now = 0;
    const meter = new SpeedMeter(() => now);
    now = 1000;
    meter.add(1000);
    expect(meter.sample()).toBe(1000);
    now = 20_000;
    meter.add(19_000);
    expect(meter.sample()).toBeGreaterThan(0);
  });

  it('records history newest first', async () => {
    const base = {
      direction: 'upload' as const,
      hostId: 'h',
      hostName: 'prod',
      sources: ['/a'],
      destination: '/b',
      files: 1,
      bytes: 1,
      durationMs: 1,
      status: 'done' as const,
    };
    await recordTransfer({ ...base, destination: '/first' });
    await recordTransfer({ ...base, destination: '/second' });
    await recordTransfer({ ...base, destination: '/first', status: 'cancelled' });
    const entries = await listHistory();
    expect(entries.map((entry) => [entry.destination, entry.status]).slice(0, 2)).toEqual([
      ['/first', 'cancelled'],
      ['/second', 'done'],
    ]);
    expect(entries.filter((entry) => entry.destination === '/first')).toHaveLength(1);
  });
});

describe('planning', () => {
  it('creates a missing folder when asked to copy into it', async () => {
    await writeFile(path.join(local, 'solo.txt'), 'solo');
    const plan = await planTransfer({
      source: localFs,
      target: remote,
      sources: [path.join(local, 'solo.txt')],
      destination: remotePath('fresh-folder'),
      intoDirectory: true,
    });
    expect(plan.files[0]?.target).toBe(remotePath('fresh-folder', 'solo.txt'));
    await runTransfer(plan);
    expect(await readFile(real('fresh-folder', 'solo.txt'), 'utf8')).toBe('solo');
  });

  it('never writes outside the destination for hostile names', async () => {
    const hostileDir = path.join(local, 'hostile');
    await mkdir(hostileDir);
    await writeFile(path.join(hostileDir, 'ok.txt'), 'fine');
    const hostile: FileSystem = Object.assign(Object.create(localFs) as FileSystem, {
      list: async (dir: string) => {
        const entries = await localFs.list(dir);
        if (dir !== hostileDir) return entries;
        const [template] = entries;
        return [
          ...entries,
          { ...template, name: '../../escape.txt' },
          { ...template, name: '..' },
          { ...template, name: 'a/b.txt' },
        ];
      },
    });
    const into = await tempDir();
    const plan = await planTransfer({
      source: hostile,
      target: localFs,
      sources: [hostileDir],
      destination: into,
    });
    expect(plan.files.map((file) => file.relative)).toEqual(['hostile/ok.txt']);
    expect(plan.skipped.filter((item) => item.reason === 'Unsafe file name')).toHaveLength(3);
    for (const file of plan.files) expect(file.target.startsWith(into + path.sep)).toBe(true);
  });

  it('refuses to copy a folder into itself', async () => {
    await mkdir(path.join(local, 'loop'));
    await expect(
      planTransfer({
        source: localFs,
        target: localFs,
        sources: [path.join(local, 'loop')],
        destination: path.join(local, 'loop', 'inner'),
      }),
    ).rejects.toThrow(/into itself/);
  });
});
