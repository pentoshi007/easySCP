import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/app/main.js';
import { createHost, type Host } from '../src/core/hosts.js';
import { cacheDir } from '../src/core/paths.js';
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

  it('sets up and removes tab completion', async () => {
    const home = await tempDir('easyscp-user-');
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('ZDOTDIR', '');
    vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
    const zshrc = path.join(home, '.zshrc');
    expect(await main(['completion', 'install', 'zsh'])).toBe(0);
    expect(output).toMatch(/Tab completion is ready for zsh \(Added to ~.\.zshrc/);
    expect(await readFile(zshrc, 'utf8')).toContain('easyscp.zsh');
    expect(await main(['completion', 'uninstall'])).toBe(0);
    expect(output).toMatch(/Removed tab completion/);
    expect(await readFile(zshrc, 'utf8')).toBe('');
    expect(await main(['completion'])).toBe(2);
    expect(await main(['completion', 'install', 'tcsh'])).toBe(2);
    expect(await main(['completion', 'fish'])).toBe(0);
    expect(output).toContain('complete -c $cmd');
  });

  it('lists machine names for shell completion', async () => {
    expect(await main(['__hosts'])).toBe(0);
    expect(output).toBe('box\ndown\n');
  });
});

describe('copy', () => {
  beforeAll(async () => {
    for (const name of ['web2', 'web3']) {
      const saved = await createHost({
        name,
        hostname: '127.0.0.1',
        port: server.port,
        user: 'u',
        auth: 'password',
      });
      await setSecret(saved.id, 'password', 'p');
    }
    await mkdir(remote('src', 'deep'), { recursive: true });
    await writeFile(remote('src', 'a.txt'), 'alpha');
    await writeFile(remote('src', 'deep', 'b.txt'), 'beta');
  });

  it('relays one source to several machines and cleans up', async () => {
    expect(await main(['copy', 'box:src', 'web2:out2', 'web3:/home/test/out3', '-y'])).toBe(0);
    expect(output).toMatch(/Copied 2 files to web2 and web3/);
    for (const dir of ['out2', 'out3']) {
      expect(await readFile(remote(dir, 'src', 'a.txt'), 'utf8')).toBe('alpha');
      expect(await readFile(remote(dir, 'src', 'deep', 'b.txt'), 'utf8')).toBe('beta');
    }
    expect(await readdir(path.join(cacheDir(), 'relay'))).toEqual([]);
    const [entry] = await listHistory();
    expect(entry).toMatchObject({ direction: 'copy', hostName: 'box', files: 2 });
    expect(entry?.targets?.map((target) => target.hostName)).toEqual(['web2', 'web3']);
  });

  it('asks for a conflict policy and skips what is already there', async () => {
    expect(await main(['copy', 'box:src', 'web2:out2', 'web3:out3'])).toBe(1);
    expect(errors).toMatch(/4 files already exist on web2 and web3/);
    expect(await main(['cp', 'box:src', 'web2:out2', 'web3:out3', '--skip'])).toBe(0);
    expect(output).toMatch(/Everything is already up to date/);
  });

  it('uses --to for machines without a folder and needs one otherwise', async () => {
    expect(await main(['copy', 'box', 'src/a.txt', 'web2', 'web3:other', '-t', 'shared'])).toBe(0);
    expect(await readFile(remote('shared', 'a.txt'), 'utf8')).toBe('alpha');
    expect(await readFile(remote('other', 'a.txt'), 'utf8')).toBe('alpha');
    expect(await main(['copy', 'box:src/a.txt', 'web2'])).toBe(1);
    expect(errors).toMatch(/Choose where to put the files on web2/);
  });

  it('still delivers to reachable machines when one is down', async () => {
    expect(await main(['copy', 'box:src/a.txt', 'web2:partial', 'down:partial'])).toBe(1);
    expect(await readFile(remote('partial', 'a.txt'), 'utf8')).toBe('alpha');
    expect(errors).toMatch(/down/);
    expect(errors).toMatch(/Connection refused/);
    expect(errors).toMatch(/Copied to 1 of 2 machines/);
  });
});

describe('send to several machines', () => {
  let local: string;

  beforeAll(async () => {
    for (const name of ['east', 'west']) {
      const saved = await createHost({
        name,
        hostname: '127.0.0.1',
        port: server.port,
        user: 'u',
        auth: 'password',
      });
      await setSecret(saved.id, 'password', 'p');
    }
    await createHost({ name: 'gone', hostname: '127.0.0.1', port: 1, user: 'u', auth: 'auto' });
    local = await tempDir();
    await mkdir(path.join(local, 'site', 'css'), { recursive: true });
    await writeFile(path.join(local, 'site', 'index.html'), 'home');
    await writeFile(path.join(local, 'site', 'css', 'app.css'), 'body{}');
    await writeFile(path.join(local, 'a.txt'), 'alpha');
    await writeFile(path.join(local, 'b.txt'), 'beta');
  });

  const relayLeftovers = async () =>
    (await readdir(path.join(cacheDir(), 'relay')).catch(() => [])).length;

  it('sends files listed before the machines into each folder', async () => {
    const site = path.join(local, 'site');
    await mkdir(remote('s1'), { recursive: true });
    await mkdir(remote('s2'), { recursive: true });
    expect(await main(['send', site, 'east:s1', 'west:/home/test/s2', '-y'])).toBe(0);
    expect(output).toMatch(/Sent 2 files to east and west/);
    for (const dir of ['s1', 's2']) {
      expect(await readFile(remote(dir, 'site', 'index.html'), 'utf8')).toBe('home');
      expect(await readFile(remote(dir, 'site', 'css', 'app.css'), 'utf8')).toBe('body{}');
    }
    expect(await relayLeftovers()).toBe(0);
    const [entry] = await listHistory();
    expect(entry).toMatchObject({
      direction: 'upload',
      hostName: 'east',
      destination: '/home/test/s1',
      files: 2,
    });
    expect(entry?.targets?.map((target) => target.hostName)).toEqual(['east', 'west']);
  });

  it('asks about existing files on every machine and skips them', async () => {
    const site = path.join(local, 'site');
    expect(await main(['send', site, 'east:s1', 'west:s2'])).toBe(1);
    expect(errors).toMatch(/4 files already exist on east and west/);
    expect(await main(['send', site, 'east:s1', 'west:s2', '--skip'])).toBe(0);
    expect(output).toMatch(/Everything is already up to date/);
  });

  it('uses --to for machines without a folder, with machines first and globs', async () => {
    const glob = path.join(local, '*.txt');
    expect(await main(['send', 'east', 'west:w', glob, '-t', 'shared-send'])).toBe(0);
    expect(output).toMatch(/Sent 2 files to east and west/);
    expect(await readFile(remote('shared-send', 'a.txt'), 'utf8')).toBe('alpha');
    expect(await readFile(remote('w', 'b.txt'), 'utf8')).toBe('beta');
  });

  it('needs a folder for each machine when it cannot ask', async () => {
    expect(await main(['send', path.join(local, 'a.txt'), 'east', 'west'])).toBe(1);
    expect(errors).toMatch(/Choose where to put the files on east and west/);
  });

  it('sends to two folders on the same machine and merges duplicates', async () => {
    const file = path.join(local, 'a.txt');
    expect(await main(['send', file, 'east:d1', 'east:d2', '-y'])).toBe(0);
    expect(output).toMatch(/Sent 1 file to east:~\/d1 and east:~\/d2/);
    expect(await readFile(remote('d1', 'a.txt'), 'utf8')).toBe('alpha');
    expect(await readFile(remote('d2', 'a.txt'), 'utf8')).toBe('alpha');
    expect(await main(['send', file, 'east:dup', 'east:/home/test/dup', '-y'])).toBe(0);
    expect(output).toMatch(/Sent 1 file to east \(/);
    expect(await main(['send', file, 'east:alias', 'west:alias', '-y'])).toBe(0);
    expect(output).toMatch(/west and east are the same machine, so ~\/alias only gets one copy/);
    expect(await readFile(remote('alias', 'a.txt'), 'utf8')).toBe('alpha');
  });

  it('treats machine:folder as a folder and creates it', async () => {
    const file = path.join(local, 'a.txt');
    expect(await main(['send', file, 'east:new/deep', 'west:new2', '-y'])).toBe(0);
    expect(await readFile(remote('new', 'deep', 'a.txt'), 'utf8')).toBe('alpha');
    expect(await readFile(remote('new2', 'a.txt'), 'utf8')).toBe('alpha');
    await writeFile(remote('a-file'), 'x');
    expect(await main(['send', file, 'east:a-file', 'west:ok-dir', '-y'])).toBe(1);
    expect(errors).toMatch(/Not a folder/);
    expect(await readFile(remote('ok-dir', 'a.txt'), 'utf8')).toBe('alpha');
  });

  it('still delivers to reachable machines when one is down', async () => {
    const file = path.join(local, 'b.txt');
    expect(await main(['send', file, 'west:partial-send', 'gone:partial-send'])).toBe(1);
    expect(await readFile(remote('partial-send', 'b.txt'), 'utf8')).toBe('beta');
    expect(errors).toMatch(/gone/);
    expect(errors).toMatch(/Sent to 1 of 2 machines/);
    const [entry] = await listHistory();
    expect(entry?.status).toBe('partial');
    expect(entry?.targets?.map((target) => target.hostName)).toEqual(['west', 'gone']);
  });

  it('explains unknown machines and missing files', async () => {
    const file = path.join(local, 'a.txt');
    expect(await main(['send', file, 'nowhere:/tmp'])).toBe(1);
    expect(errors).toMatch(/No saved machine named "nowhere"/);
    expect(await main(['send', file, 'nowhere'])).toBe(1);
    expect(errors).toMatch(/No saved machine named "nowhere"/);
    expect(await main(['send', path.join(local, 'missing.txt'), 'east:x', 'west:x'])).toBe(1);
    expect(errors).toMatch(/Not found/);
  });

  it('repeats a multi-machine send from history and forgets removed machines', async () => {
    const { repeatTransfer, describeEntry } = await import('../src/commands/history.js');
    const { createContext } = await import('../src/app/context.js');
    const { parseCommandLine } = await import('../src/cli/args.js');
    const { Ui } = await import('../src/ui/ui.js');
    const { forgetHostHistory } = await import('../src/transfer/history.js');
    const file = path.join(local, 'a.txt');
    expect(await main(['send', file, 'east:rep1', 'west:rep2', '-y'])).toBe(0);
    const [entry] = await listHistory();
    if (!entry) throw new Error('missing history entry');
    expect(describeEntry(entry).label).toMatch(/east and west/);
    expect(describeEntry(entry).hint).toMatch(/to east and west/);

    await writeFile(remote('rep1', 'a.txt'), 'changed');
    await writeFile(remote('rep2', 'a.txt'), 'changed');
    const ui = new Ui();
    const ctx = createContext(ui, parseCommandLine(['send', '--overwrite']));
    try {
      const outcome = await repeatTransfer(ctx, entry);
      expect(outcome.message).toMatch(/Sent 1 file to east and west/);
    } finally {
      ctx.close();
      await ui.close();
    }
    expect(await readFile(remote('rep1', 'a.txt'), 'utf8')).toBe('alpha');
    expect(await readFile(remote('rep2', 'a.txt'), 'utf8')).toBe('alpha');

    await forgetHostHistory(entry.hostId);
    const [kept] = await listHistory();
    expect(kept).toMatchObject({ hostName: 'west', direction: 'upload' });
    expect(kept?.targets?.map((target) => target.hostName)).toEqual(['west']);
  });
});
