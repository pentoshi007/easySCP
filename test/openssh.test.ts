import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/app/main.js';
import { createHost, type Host } from '../src/core/hosts.js';
import { appFile } from '../src/core/paths.js';
import { RemoteFileSystem } from '../src/fs/remote.js';
import { indexTree } from '../src/fs/search.js';
import { nonInteractive } from '../src/ssh/interaction.js';
import { Session } from '../src/ssh/session.js';
import { isolatedEnvironment } from './helpers/env.js';
import { tempDir } from './helpers/tmp.js';

const find = (candidates: string[]) => candidates.find((file) => existsSync(file));
const sshd = find(['/usr/sbin/sshd', '/usr/bin/sshd', '/usr/local/sbin/sshd']);
const sftpServer = find([
  '/usr/libexec/sftp-server',
  '/usr/lib/openssh/sftp-server',
  '/usr/lib/ssh/sftp-server',
  '/usr/libexec/openssh/sftp-server',
]);
const available = process.platform !== 'win32' && Boolean(sshd && sftpServer);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function keygen(file: string): void {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { stdio: 'ignore' });
}

function startServer(config: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(sshd as string, ['-D', '-e', '-f', config], { stdio: 'pipe' });
    let log = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`sshd did not start:\n${log}`));
    }, 8000);
    child.stderr?.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      if (log.includes('Server listening')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`sshd exited with ${code}:\n${log}`));
    });
  });
}

const digest = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

describe.runIf(available)('against OpenSSH', () => {
  let server: ChildProcess;
  let host: Host;
  let remoteRoot: string;
  let output = '';

  beforeAll(async () => {
    await isolatedEnvironment();
    const dir = await tempDir('easyscp-sshd-');
    const port = await freePort();
    keygen(path.join(dir, 'host_key'));
    keygen(path.join(dir, 'client_key'));
    await writeFile(
      path.join(dir, 'authorized_keys'),
      await readFile(path.join(dir, 'client_key.pub')),
      { mode: 0o600 },
    );
    const config = path.join(dir, 'sshd_config');
    await writeFile(
      config,
      [
        `Port ${port}`,
        'ListenAddress 127.0.0.1',
        `HostKey ${path.join(dir, 'host_key')}`,
        `AuthorizedKeysFile ${path.join(dir, 'authorized_keys')}`,
        `PidFile ${path.join(dir, 'sshd.pid')}`,
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'StrictModes no',
        'UsePAM no',
        `Subsystem sftp ${sftpServer}`,
        '',
      ].join('\n'),
    );
    server = await startServer(config);
    host = await createHost({
      name: 'real',
      hostname: '127.0.0.1',
      port,
      user: os.userInfo().username,
      auth: 'key',
      identityFile: path.join(dir, 'client_key'),
    });
    remoteRoot = await tempDir('easyscp-remote-');
  });

  afterAll(() => {
    server?.kill();
  });

  beforeEach(() => {
    output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
  });

  it('trusts the host key on first use and logs in with a key', async () => {
    expect(await main(['test', 'real', '-y'])).toBe(0);
    expect(output).toMatch(/Connected to real/);
    expect(output).toMatch(/OpenSSH/);
    expect(await readFile(appFile('known_hosts'), 'utf8')).toMatch(
      /^\[127\.0\.0\.1\]:\d+ ssh-ed25519 /,
    );
  });

  it('round-trips files and folders byte for byte', async () => {
    const local = await tempDir();
    await mkdir(path.join(local, 'site', 'assets'), { recursive: true });
    const big = Buffer.alloc(5 * 1024 * 1024 + 123);
    for (let index = 0; index < big.length; index += 4096) big[index] = index % 251;
    await writeFile(path.join(local, 'site', 'assets', 'blob.bin'), big);
    await writeFile(path.join(local, 'site', 'index.html'), '<h1>hi</h1>');

    expect(await main(['send', 'real', path.join(local, 'site'), '--to', remoteRoot])).toBe(0);
    expect(await digest(path.join(remoteRoot, 'site', 'assets', 'blob.bin'))).toBe(
      await digest(path.join(local, 'site', 'assets', 'blob.bin')),
    );

    const back = await tempDir();
    expect(await main(['get', 'real', path.join(remoteRoot, 'site'), '--to', back])).toBe(0);
    expect(await readFile(path.join(back, 'site', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
    expect(await digest(path.join(back, 'site', 'assets', 'blob.bin'))).toBe(
      await digest(path.join(local, 'site', 'assets', 'blob.bin')),
    );

    expect(await main(['send', 'real', path.join(local, 'site'), '--to', remoteRoot])).toBe(1);
    expect(output).toMatch(/already exist/);
    expect(
      await main(['send', 'real', path.join(local, 'site'), '--to', remoteRoot, '--skip']),
    ).toBe(0);
  });

  it('indexes remote folders', async () => {
    const session = await Session.open(host, {
      interaction: nonInteractive({ acceptNewHostKeys: false }),
    });
    try {
      const fs = new RemoteFileSystem(session);
      const found: string[] = [];
      await indexTree(fs, remoteRoot, {
        onEntries: (batch) => found.push(...batch.map((entry) => entry.path)),
      });
      expect(found).toEqual(
        expect.arrayContaining(['site', 'site/assets', 'site/assets/blob.bin']),
      );
    } finally {
      session.close();
    }
  });
});
