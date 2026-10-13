import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/app/main.js';
import { createHost, type Host } from '../src/core/hosts.js';
import { setSecret } from '../src/core/secrets.js';
import { listHistory } from '../src/transfer/history.js';
import { isolatedEnvironment } from './helpers/env.js';
import { startTestServer, type TestServer } from './helpers/sftpServer.js';
import { tempDir } from './helpers/tmp.js';

let server: TestServer;
let remoteRoot: string;
let host: Host;
let output: string;
let errors: string;

const remote = (...parts: string[]) => path.join(remoteRoot, 'home', 'test', ...parts);

beforeAll(async () => {
  await isolatedEnvironment();
  remoteRoot = await tempDir();
  server = await startTestServer({ root: remoteRoot, users: [{ username: 'u', password: 'p' }] });
  host = await createHost({
    name: 'box',
    hostname: '127.0.0.1',
    port: server.port,
    user: 'u',
    auth: 'password',
  });
  await setSecret(host.id, 'password', 'p');
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  output = '';
  errors = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors += String(chunk);
    return true;
  });
});

describe('cli', () => {
  it('refuses unknown machines without --yes when not interactive', async () => {
    const local = await tempDir();
    await writeFile(path.join(local, 'a.txt'), 'a');
    expect(await main(['send', 'box', path.join(local, 'a.txt'), '--to', 'up'])).toBe(1);
    expect(errors).toMatch(/not a trusted machine yet/);
  });

  it('sends and receives with globs, conflicts and history', async () => {
    const local = await tempDir();
    await writeFile(path.join(local, 'a.txt'), 'alpha');
    await writeFile(path.join(local, 'b.txt'), 'beta');

    expect(await main(['send', 'box', path.join(local, '*.txt'), '--to', 'up', '-y'])).toBe(0);
    expect(output).toMatch(/Sent 2 files to box:~\/up/);
    expect(await readFile(remote('up', 'b.txt'), 'utf8')).toBe('beta');

    expect(await main(['send', 'box', path.join(local, 'a.txt'), '--to', 'up'])).toBe(1);
    expect(errors).toMatch(/1 file already exists/);

    const downloads = path.join(local, 'downloads');
    await mkdir(downloads);
    expect(await main(['get', 'box', 'up/*.txt', '--to', downloads])).toBe(0);
    expect(await readFile(path.join(downloads, 'a.txt'), 'utf8')).toBe('alpha');

    const history = await listHistory();
    expect(history.map((entry) => entry.direction)).toEqual(['download', 'upload']);
  });

  it('prints machines as json', async () => {
    expect(await main(['list', '--json'])).toBe(0);
    expect(JSON.parse(output)[0]).toMatchObject({ name: 'box', user: 'u' });
  });

  it('reports usage errors with exit code 2', async () => {
    expect(await main(['sned'])).toBe(2);
    expect(errors).toMatch(/Did you mean `easyscp send`/);
    expect(await main(['completion', 'tcsh'])).toBe(2);
  });

  it('reports connection failures on stderr with a hint', async () => {
    await createHost({ name: 'down', hostname: '127.0.0.1', port: 1, user: 'u', auth: 'auto' });
    expect(await main(['test', 'down'])).toBe(1);
    expect(output).toBe('');
    expect(errors).toMatch(/Could not connect to down: Connection refused/);
    expect(errors).toMatch(/Is the SSH server running/);
  });

  it('lists machine names for shell completion', async () => {
    expect(await main(['__hosts'])).toBe(0);
    expect(output).toBe('box\ndown\n');
  });
});
