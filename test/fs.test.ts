import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHost } from '../src/core/hosts.js';
import { setSecret } from '../src/core/secrets.js';
import { localFs } from '../src/fs/local.js';
import { compareEntries, displayPath, ensureDir, resolveInput, uniqueName } from '../src/fs/ops.js';
import { RemoteFileSystem } from '../src/fs/remote.js';
import { type IndexEntry, indexTree } from '../src/fs/search.js';
import type { FileSystem } from '../src/fs/types.js';
import { Session } from '../src/ssh/session.js';
import { isolatedEnvironment } from './helpers/env.js';
import { scripted } from './helpers/interaction.js';
import { startTestServer, type TestServer } from './helpers/sftpServer.js';
import { tempDir } from './helpers/tmp.js';

const POSIX = process.platform !== 'win32';

interface Fixture {
  fs: FileSystem;
  root: string;
  real: (...parts: string[]) => string;
  commands?: string[];
}

async function seed(real: (...parts: string[]) => string) {
  await mkdir(real('docs', 'deep', 'er'), { recursive: true });
  await mkdir(real('node_modules', 'pkg'), { recursive: true });
  await writeFile(real('readme.md'), 'hello');
  await writeFile(real('.env'), 'SECRET=1');
  await writeFile(real('docs', 'guide.txt'), 'guide');
  await writeFile(real('docs', 'deep', 'er', 'needle.log'), 'x'.repeat(1234));
  await writeFile(real('node_modules', 'pkg', 'index.js'), '');
  await utimes(real('readme.md'), 1_600_000_000, 1_600_000_000);
  if (POSIX) await symlink(real('docs'), real('docs-link'));
}

function suite(name: string, setup: () => Promise<Fixture>, teardown?: () => Promise<void>) {
  describe(name, () => {
    let fx: Fixture;

    beforeAll(async () => {
      fx = await setup();
      await seed(fx.real);
    });

    afterAll(async () => {
      await teardown?.();
    });

    const at = (...parts: string[]) => fx.fs.path.join(fx.root, ...parts);

    it('lists entries with kinds, sizes and times', async () => {
      const entries = (await fx.fs.list(fx.root)).sort(compareEntries);
      const names = entries.map((entry) => entry.name);
      expect(names.slice(0, 2)).toEqual(['docs', ...(POSIX ? ['docs-link'] : ['node_modules'])]);
      const readme = entries.find((entry) => entry.name === 'readme.md');
      expect(readme).toMatchObject({ kind: 'file', size: 5, mtime: 1_600_000_000_000 });
      if (POSIX) {
        expect(entries.find((entry) => entry.name === 'docs-link')).toMatchObject({
          kind: 'dir',
          link: true,
        });
      }
    });

    it('stats missing paths as undefined', async () => {
      expect(await fx.fs.stat(at('nope'))).toBeUndefined();
      expect((await fx.fs.stat(at('docs')))?.kind).toBe('dir');
    });

    it('creates nested directories and refuses files in the way', async () => {
      await ensureDir(fx.fs, at('made', 'a', 'b'));
      expect((await fx.fs.stat(at('made', 'a', 'b')))?.kind).toBe('dir');
      await expect(ensureDir(fx.fs, at('readme.md', 'x'))).rejects.toMatchObject({
        code: 'ENOTDIR',
      });
    });

    it('writes positionally and reads back', async () => {
      const file = at('written.bin');
      const writer = await fx.fs.openWrite(file, false);
      await writer.write(Buffer.from('world'), 0, 5, 6);
      await writer.write(Buffer.from('hello '), 0, 6, 0);
      await writer.finish({ mtime: 1_700_000_000_000 });
      await writer.close();
      expect(await readFile(fx.real('written.bin'), 'utf8')).toBe('hello world');
      expect((await fx.fs.stat(file))?.mtime).toBe(1_700_000_000_000);

      const reader = await fx.fs.openRead(file);
      const buffer = Buffer.alloc(32);
      expect(await reader.read(buffer, 0, 32, 6)).toBe(5);
      expect(await reader.read(buffer, 0, 32, 11)).toBe(0);
      await reader.close();
    });

    it('renames over existing files', async () => {
      await writeFile(fx.real('from.txt'), 'new');
      await writeFile(fx.real('to.txt'), 'old');
      await fx.fs.rename(at('from.txt'), at('to.txt'));
      expect(await readFile(fx.real('to.txt'), 'utf8')).toBe('new');
      expect(await fx.fs.stat(at('from.txt'))).toBeUndefined();
    });

    it('removes trees', async () => {
      await mkdir(fx.real('trash', 'inner'), { recursive: true });
      await writeFile(fx.real('trash', 'inner', 'f'), '1');
      await fx.fs.remove([at('trash')]);
      expect(await fx.fs.stat(at('trash'))).toBeUndefined();
    });

    it('picks unique names', async () => {
      expect(await uniqueName(fx.fs, fx.root, 'readme.md')).toBe('readme (1).md');
      expect(await uniqueName(fx.fs, fx.root, '.env')).toBe('.env (1)');
    });

    it('indexes trees while skipping noise', async () => {
      const found: IndexEntry[] = [];
      const result = await indexTree(fx.fs, fx.root, {
        onEntries: (batch) => found.push(...batch),
      });
      const paths = found.map((entry) => entry.path);
      expect(paths).toContain('docs/deep/er/needle.log');
      expect(found.find((entry) => entry.path === 'docs/deep')?.dir).toBe(true);
      expect(paths.some((entry) => entry.startsWith('node_modules'))).toBe(false);
      expect(result.count).toBe(found.length);
      if (fx.commands) expect(fx.commands.some((command) => command.includes('find'))).toBe(true);
    });

    it('honours index limits', async () => {
      const found: IndexEntry[] = [];
      const result = await indexTree(fx.fs, fx.root, {
        limit: 3,
        onEntries: (batch) => found.push(...batch),
      });
      expect(result.truncated).toBe(true);
      expect(found.length).toBe(3);
    });

    it('resolves user input', () => {
      expect(resolveInput(fx.fs, '~', fx.root)).toBe(fx.fs.home);
      expect(resolveInput(fx.fs, 'docs', fx.root)).toBe(at('docs'));
      expect(displayPath(fx.fs, fx.fs.path.join(fx.fs.home, 'x'))).toBe(`~${fx.fs.path.sep}x`);
    });
  });
}

suite('local filesystem', async () => {
  const root = await tempDir();
  return { fs: localFs, root, real: (...parts) => path.join(root, ...parts) };
});

let server: TestServer;
let session: Session;

async function remoteFixture(supportsExec: boolean): Promise<Fixture> {
  await isolatedEnvironment();
  const real = await tempDir();
  const options = supportsExec
    ? { root: '/', home: real, supportsExec }
    : { root: real, home: '/home/test' };
  server = await startTestServer({ ...options, users: [{ username: 'u', password: 'p' }] });
  const host = await createHost({
    name: 'test',
    hostname: '127.0.0.1',
    port: server.port,
    user: 'u',
    auth: 'password',
  });
  await setSecret(host.id, 'password', 'p');
  session = await Session.open(host, { interaction: scripted() });
  const fs = new RemoteFileSystem(session);
  const base = supportsExec ? real : path.join(real, 'home', 'test');
  return {
    fs,
    root: session.home,
    real: (...parts) => path.join(base, ...parts),
    commands: supportsExec ? server.commands : undefined,
  };
}

async function closeRemote() {
  session?.close();
  await server?.close();
}

suite('remote filesystem (sftp walk)', () => remoteFixture(false), closeRemote);

if (POSIX) {
  suite('remote filesystem (find via exec)', () => remoteFixture(true), closeRemote);
}
