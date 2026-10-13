import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHost } from '../src/core/hosts.js';
import { setSecret } from '../src/core/secrets.js';
import { localFs } from '../src/fs/local.js';
import { partName } from '../src/fs/names.js';
import { RemoteFileSystem } from '../src/fs/remote.js';
import type { FileSystem, Reader, Writer } from '../src/fs/types.js';
import { type RelayTarget, runRelay } from '../src/relay/run.js';
import { createStage, type Stage } from '../src/relay/stage.js';
import { Session } from '../src/ssh/session.js';
import { planTransfer } from '../src/transfer/plan.js';
import { isolatedEnvironment } from './helpers/env.js';
import { scripted } from './helpers/interaction.js';
import { startTestServer, type TestServer } from './helpers/sftpServer.js';
import { tempDir } from './helpers/tmp.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

let server: TestServer;
let session: Session;
let remoteRoot: string;
let cacheRoot: string;
const sessions: Session[] = [];

const real = (...parts: string[]) => path.join(remoteRoot, 'home', 'test', ...parts);
const remotePath = (...parts: string[]) => path.posix.join('/home/test', ...parts);

async function connectSession() {
  const host = await createHost({
    name: `r${Math.random().toString(36).slice(2, 8)}`,
    hostname: '127.0.0.1',
    port: server.port,
    user: 'u',
    auth: 'password',
  });
  await setSecret(host.id, 'password', 'p');
  const opened = await Session.open(host, { interaction: scripted() });
  sessions.push(opened);
  return opened;
}

function proxy(fs: FileSystem, overrides: Partial<FileSystem>): FileSystem {
  return new Proxy(fs, {
    get(target, property) {
      if (property in overrides) return overrides[property as keyof FileSystem];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function counting(fs: FileSystem) {
  const meter = { bytes: 0 };
  const source = proxy(fs, {
    openRead: async (file: string): Promise<Reader> => {
      const reader = await fs.openRead(file);
      return {
        read: async (...args) => {
          const count = await reader.read(...args);
          meter.bytes += count;
          return count;
        },
        close: () => reader.close(),
      };
    },
  });
  return { source, meter };
}

function onFirstWrite(fs: FileSystem, trigger: () => void): FileSystem {
  let fired = false;
  return proxy(fs, {
    openWrite: async (file: string, append: boolean): Promise<Writer> => {
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
    },
  });
}

async function target(
  key: string,
  stage: Stage,
  fs: FileSystem,
  destination: string,
): Promise<RelayTarget> {
  const plan = await planTransfer({
    source: stage,
    target: fs,
    sources: [remotePath('src')],
    destination,
    placement: 'into',
  });
  return { key, label: key, plan };
}

const big = randomBytes(12 * 1024 * 1024 + 4321);
const small = Buffer.from('relay me');

beforeAll(async () => {
  await isolatedEnvironment();
  remoteRoot = await tempDir();
  server = await startTestServer({ root: remoteRoot, users: [{ username: 'u', password: 'p' }] });
  session = await connectSession();
  await mkdir(real('src', 'nested'), { recursive: true });
  await writeFile(real('src', 'big.bin'), big);
  await writeFile(real('src', 'nested', 'note.txt'), small);
});

afterAll(async () => {
  for (const open of sessions) open.close();
  await server?.close();
});

beforeEach(async () => {
  cacheRoot = await tempDir();
});

async function expectCopied(dir: string) {
  expect(sha(await readFile(path.join(dir, 'src', 'big.bin')))).toBe(sha(big));
  expect(await readFile(path.join(dir, 'src', 'nested', 'note.txt'), 'utf8')).toBe('relay me');
}

describe('relay', () => {
  it('reads the source once and fans out to every machine', async () => {
    const { source, meter } = counting(new RemoteFileSystem(session));
    const stage = await createStage(source, { root: cacheRoot, budget: 64 * 1024 * 1024 });
    const extra = new RemoteFileSystem(await connectSession());
    const dirs = [await tempDir(), await tempDir()];
    const targets = [
      await target('one', stage, localFs, dirs[0] as string),
      await target('two', stage, localFs, dirs[1] as string),
      await target('three', stage, extra, remotePath('out')),
    ];
    const outcomes = await runRelay(stage, targets, { policy: 'skip' });

    expect(outcomes.map((outcome) => outcome.result.status)).toEqual(['done', 'done', 'done']);
    for (const dir of dirs) await expectCopied(dir as string);
    await expectCopied(real('out'));
    expect(meter.bytes).toBe(big.length + small.length);
    expect(stage.stats.stored).toBe(0);
    expect(await readdir(stage.dir)).toEqual([]);
    await stage.close();
    expect(await readdir(cacheRoot)).toEqual([]);
  });

  it('streams straight through when there is no room to cache', async () => {
    const { source, meter } = counting(new RemoteFileSystem(session));
    const stage = await createStage(source, { root: cacheRoot, budget: 0 });
    const dirs = [await tempDir(), await tempDir()];
    const targets = await Promise.all(
      dirs.map((dir, index) => target(`t${index}`, stage, localFs, dir)),
    );
    const outcomes = await runRelay(stage, targets, { policy: 'skip' });
    expect(outcomes.every((outcome) => outcome.result.status === 'done')).toBe(true);
    for (const dir of dirs) await expectCopied(dir);
    expect(meter.bytes).toBe(2 * (big.length + small.length));
    expect(stage.stats.direct).toBe(meter.bytes);
    await stage.close();
  });

  it('only fetches what a resumed copy still needs', async () => {
    const { source, meter } = counting(new RemoteFileSystem(session));
    const stage = await createStage(source, { root: cacheRoot, budget: 64 * 1024 * 1024 });
    const dir = await tempDir();
    await mkdir(path.join(dir, 'src', 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'nested', 'note.txt'), small);
    await writeFile(path.join(dir, 'src', partName('big.bin')), big.subarray(0, 11 * 1024 * 1024));
    const outcomes = await runRelay(stage, [await target('only', stage, localFs, dir)], {
      policy: 'skip',
    });
    expect(outcomes[0]?.result.status).toBe('done');
    await expectCopied(dir);
    expect(meter.bytes).toBeLessThan(big.length / 2);
    await stage.close();
  });

  it('finishes the other machines when one of them fails', async () => {
    const stage = await createStage(new RemoteFileSystem(session), { root: cacheRoot });
    const good = await tempDir();
    const broken = proxy(localFs, {
      openWrite: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    });
    const outcomes = await runRelay(
      stage,
      [
        await target('good', stage, localFs, good),
        await target('bad', stage, broken, await tempDir()),
      ],
      { policy: 'skip' },
    );
    expect(outcomes.map((outcome) => outcome.result.status)).toEqual(['done', 'failed']);
    expect(outcomes[1]?.result.failed).toHaveLength(2);
    await expectCopied(good);
    await stage.close();
  });

  it('reconnects a machine that dropped and resumes it', async () => {
    const stage = await createStage(new RemoteFileSystem(session), { root: cacheRoot });
    const flaky = await connectSession();
    const dropping = onFirstWrite(new RemoteFileSystem(flaky), () => flaky.close());
    const relay = await target('flaky', stage, dropping, remotePath('flaky'));
    relay.reconnect = async () => new RemoteFileSystem(await connectSession());
    const outcomes = await runRelay(stage, [relay], { policy: 'skip', retryDelayMs: 10 });
    expect(outcomes[0]?.result.status).toBe('done');
    expect(outcomes[0]?.attempts).toBe(2);
    await expectCopied(real('flaky'));
    await stage.close();
  });

  it('reconnects the source and keeps what it already cached', async () => {
    const first = await connectSession();
    const stage = await createStage(new RemoteFileSystem(first), { root: cacheRoot });
    const dir = await tempDir();
    const dropping = onFirstWrite(localFs, () => first.close());
    const outcomes = await runRelay(stage, [await target('local', stage, dropping, dir)], {
      policy: 'skip',
      retryDelayMs: 10,
      reconnectSource: async () => new RemoteFileSystem(await connectSession()),
    });
    expect(outcomes[0]?.result.status).toBe('done');
    await expectCopied(dir);
    await stage.close();
  });

  it('removes staging folders left behind by dead processes', async () => {
    await mkdir(path.join(cacheRoot, '999999999-abc', 'nested'), { recursive: true });
    const stage = await createStage(new RemoteFileSystem(session), { root: cacheRoot });
    expect(await readdir(cacheRoot)).toEqual([path.basename(stage.dir)]);
    await stage.close();
  });
});
