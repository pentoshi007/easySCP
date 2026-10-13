import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKey } from './helpers/keys.js';
import { startTestServer, type TestServer } from './helpers/sftpServer.js';
import { tempDir } from './helpers/tmp.js';

const run = promisify(execFile);
const binary = process.env.EASYSCP_BINARY;

describe.skipIf(!binary)('standalone binary', () => {
  let server: TestServer;
  let env: NodeJS.ProcessEnv;
  let remoteRoot: string;
  let local: string;

  const remote = (...parts: string[]) => path.join(remoteRoot, 'home', 'test', ...parts);
  const easyscp = async (...args: string[]) =>
    (await run(path.resolve(binary as string), args, { env, timeout: 60_000 })).stdout;

  beforeAll(async () => {
    const key = generateKey();
    remoteRoot = await tempDir();
    await mkdir(remote(), { recursive: true });
    server = await startTestServer({
      root: remoteRoot,
      users: [{ username: 'u', publicKey: key.public }],
    });
    const home = await tempDir();
    local = await tempDir();
    const identityFile = path.join(home, 'id_ed25519');
    await writeFile(identityFile, key.private, { mode: 0o600 });
    const hosts = ['one', 'two', 'three'].map((name, index) => ({
      id: `smoke-${name}`,
      name,
      hostname: '127.0.0.1',
      port: server.port,
      user: 'u',
      auth: 'key',
      identityFile,
      createdAt: index,
    }));
    await writeFile(path.join(home, 'hosts.json'), JSON.stringify({ version: 1, hosts }));
    env = {
      ...process.env,
      EASYSCP_HOME: home,
      EASYSCP_SECRETS: 'file',
      EASYSCP_NO_UPDATE_CHECK: '1',
      SSH_AUTH_SOCK: '',
    };
  });

  afterAll(async () => {
    await server?.close();
  });

  it('reports its version and prints help and completion scripts', async () => {
    const pkg = JSON.parse(
      await readFile(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    );
    expect((await easyscp('--version')).trim()).toBe(pkg.version);
    expect(await easyscp('--help')).toContain('copy');
    expect(await easyscp('completion', 'powershell')).toContain('Register-ArgumentCompleter');
    expect(JSON.parse(await easyscp('list', '--json'))).toHaveLength(3);
  });

  it('sends, receives and relays files over SSH', async () => {
    await mkdir(path.join(local, 'site', 'css'), { recursive: true });
    await writeFile(path.join(local, 'site', 'index.html'), '<h1>hi</h1>');
    await writeFile(path.join(local, 'site', 'css', 'app.css'), 'body{}');

    await easyscp('send', 'one', path.join(local, 'site'), '-t', 'www', '-y');
    expect(await readFile(remote('www', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');

    await mkdir(path.join(local, 'back'));
    await easyscp('get', 'one', 'www/css', '-t', path.join(local, 'back'), '-y');
    expect(await readFile(path.join(local, 'back', 'css', 'app.css'), 'utf8')).toBe('body{}');

    expect(await easyscp('copy', 'one:www', 'two:a', 'three:b', '-y')).toMatch(
      /Copied 2 files to two and three/,
    );
    for (const dir of ['a', 'b']) {
      expect(await readFile(remote(dir, 'www', 'css', 'app.css'), 'utf8')).toBe('body{}');
    }
  });
});
