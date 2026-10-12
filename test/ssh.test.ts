import { writeFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancelledError } from '../src/core/errors.js';
import { createHost, type HostDraft } from '../src/core/hosts.js';
import { getSecret, setSecret } from '../src/core/secrets.js';
import { describeHostKey, trustHostKey } from '../src/ssh/knownHosts.js';
import { Session } from '../src/ssh/session.js';
import { isolatedEnvironment } from './helpers/env.js';
import { scripted } from './helpers/interaction.js';
import { generateKey } from './helpers/keys.js';
import { startTestServer, type TestServer } from './helpers/sftpServer.js';
import { tempDir } from './helpers/tmp.js';

const keyPair = generateKey('ed25519', {
  passphrase: 'open sesame',
  cipher: 'aes256-cbc',
  rounds: 2,
});

describe('ssh sessions', () => {
  let server: TestServer;
  let sshDir: string;
  const sessions: Session[] = [];

  async function host(patch: Partial<HostDraft> = {}) {
    return createHost({
      name: `h${Math.random().toString(36).slice(2, 8)}`,
      hostname: '127.0.0.1',
      port: server.port,
      user: 'alice',
      auth: 'password',
      ...patch,
    });
  }

  async function open(...args: Parameters<typeof Session.open>) {
    const session = await Session.open(...args);
    sessions.push(session);
    return session;
  }

  beforeEach(async () => {
    ({ sshDir } = await isolatedEnvironment());
    server = await startTestServer({
      root: await tempDir(),
      allowForwarding: true,
      users: [
        { username: 'alice', password: 'wonderland' },
        { username: 'bob', publicKey: keyPair.public },
        { username: 'carol', password: 'otp', keyboardInteractive: true },
      ],
    });
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.close();
    await server.close();
  });

  it('logs in with a saved password and trusts the host key on first use', async () => {
    const target = await host();
    await setSecret(target.id, 'password', 'wonderland');

    const first = scripted();
    const session = await open(target, { interaction: first });
    expect(session.home).toBe('/home/test');
    expect(session.windows).toBe(false);
    expect(first.hostKeys).toHaveLength(1);
    expect(first.hostKeys[0]?.status).toBe('unknown');
    expect(first.hostKeys[0]?.key.fingerprint).toBe(
      describeHostKey(server.hostKey.getPublicSSH()).fingerprint,
    );

    const second = scripted();
    await open(target, { interaction: second });
    expect(second.hostKeys).toHaveLength(0);
    expect(second.secrets).toHaveLength(0);
  });

  it('refuses untrusted and changed host keys', async () => {
    const target = await host();
    await setSecret(target.id, 'password', 'wonderland');
    await expect(open(target, { interaction: scripted({ trust: false }) })).rejects.toThrow(
      /not trusted/,
    );

    const impostor = generateKey();
    await trustHostKey('127.0.0.1', server.port, describeHostKey(impostor.parsed.getPublicSSH()));

    const interaction = scripted({ trust: false });
    await expect(open(target, { interaction })).rejects.toThrow(/has changed/);
    expect(interaction.hostKeys[0]?.status).toBe('changed');
  });

  it('re-prompts after a wrong saved password and stores the corrected one', async () => {
    const target = await host();
    await setSecret(target.id, 'password', 'stale');
    const interaction = scripted({ answers: ['nope', 'wonderland'] });
    await open(target, { interaction });
    expect(interaction.secrets.map((question) => question.retry)).toEqual([true, true]);
    expect(await getSecret(target.id, 'password')).toBe('wonderland');
  });

  it('fails with a clear error after three wrong passwords', async () => {
    const target = await host();
    const interaction = scripted({ answers: ['a', 'b', 'c'] });
    await expect(open(target, { interaction })).rejects.toThrow(/Permission denied/);
    expect(interaction.secrets).toHaveLength(3);
  });

  it('cancels when the password prompt is dismissed', async () => {
    const target = await host();
    await expect(
      open(target, { interaction: scripted({ answers: [undefined] }) }),
    ).rejects.toBeInstanceOf(CancelledError);
  });

  it('uses encrypted keys and asks for the passphrase', async () => {
    const keyFile = path.join(sshDir, 'work_key');
    await writeFile(keyFile, keyPair.private);
    const target = await host({ user: 'bob', auth: 'key', identityFile: keyFile });
    const interaction = scripted({ answers: ['wrong', 'open sesame'] });
    await open(target, { interaction });
    expect(interaction.secrets.map((question) => question.kind)).toEqual([
      'passphrase',
      'passphrase',
    ]);
  });

  it('auto mode discovers default keys', async () => {
    await writeFile(path.join(sshDir, 'id_ed25519'), keyPair.private);
    const target = await host({ user: 'bob', auth: 'auto' });
    await setSecret(target.id, 'passphrase', 'unused');
    const interaction = scripted({ answers: ['open sesame'] });
    await open(target, { interaction });
    expect(interaction.secrets).toHaveLength(1);
  });

  it('answers keyboard-interactive password prompts', async () => {
    const target = await host({ user: 'carol' });
    const interaction = scripted({ answers: ['otp'] });
    await open(target, { interaction });
    expect(interaction.secrets[0]?.kind).toBe('password');
  });

  it('reports missing identity files', async () => {
    const target = await host({ user: 'bob', auth: 'key', identityFile: '~/.ssh/missing' });
    await expect(open(target, { interaction: scripted() })).rejects.toMatchObject({
      hint: expect.stringContaining('Identity file not found'),
    });
  });

  it('connects through a jump host', async () => {
    const bastion = await host({ name: 'bastion' });
    const target = await host({ jump: 'bastion' });
    await setSecret(bastion.id, 'password', 'wonderland');
    await setSecret(target.id, 'password', 'wonderland');
    const session = await open(target, { interaction: scripted() });
    expect(session.home).toBe('/home/test');
    expect(server.connections).toBe(2);
  });

  it('detects jump host loops', async () => {
    await host({ name: 'loop-a', jump: 'loop-b' });
    const b = await host({ name: 'loop-b', jump: 'loop-a' });
    await expect(open(b, { interaction: scripted() })).rejects.toThrow(/loop/);
  });

  it('times out on unresponsive servers', async () => {
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const target = await host({ port: (silent.address() as AddressInfo).port });
      await expect(open(target, { interaction: scripted(), timeoutMs: 300 })).rejects.toThrow(
        /Timed out/,
      );
    } finally {
      silent.close();
    }
  });

  it('honours abort signals', async () => {
    const target = await host();
    const controller = new AbortController();
    const interaction = scripted();
    interaction.askSecret = async () => {
      controller.abort();
      return 'wonderland';
    };
    await expect(open(target, { interaction, signal: controller.signal })).rejects.toBeInstanceOf(
      CancelledError,
    );
  });
});
