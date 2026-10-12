import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { utils } from 'ssh2';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkEntries,
  checkHostKey,
  describeHostKey,
  knownHostName,
  parseKnownHosts,
  preferredHostKeyAlgorithms,
  trustHostKey,
} from '../src/ssh/knownHosts.js';
import { isolateAppHome, tempDir } from './helpers/tmp.js';

function makeKey(type: 'ed25519' | 'ecdsa' = 'ed25519') {
  const pair =
    type === 'ecdsa'
      ? utils.generateKeyPairSync('ecdsa', { bits: 256 })
      : utils.generateKeyPairSync('ed25519');
  const parsed = utils.parseKey(pair.public);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('bad key');
  return describeHostKey(parsed.getPublicSSH());
}

function hashed(name: string): string {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(name).digest();
  return `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
}

describe('known_hosts parsing', () => {
  const key = makeKey();
  const other = makeKey();

  it('formats host names like OpenSSH', () => {
    expect(knownHostName('example.com', 22)).toBe('example.com');
    expect(knownHostName('example.com', 2222)).toBe('[example.com]:2222');
  });

  it('describes keys with SHA256 fingerprints', () => {
    expect(key.type).toBe('ssh-ed25519');
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('matches plain, wildcard, negated and hashed entries', () => {
    const entries = parseKnownHosts(
      [
        '# comment',
        `example.com,10.0.0.1 ${key.type} ${key.base64}`,
        `*.corp.net,!evil.corp.net ${key.type} ${key.base64}`,
        `${hashed('[secret.io]:2222')} ${key.type} ${key.base64}`,
      ].join('\n'),
    );
    expect(checkEntries(entries, 'example.com', key).status).toBe('trusted');
    expect(checkEntries(entries, 'build.corp.net', key).status).toBe('trusted');
    expect(checkEntries(entries, 'evil.corp.net', key).status).toBe('unknown');
    expect(checkEntries(entries, '[secret.io]:2222', key).status).toBe('trusted');
    expect(checkEntries(entries, 'secret.io', key).status).toBe('unknown');
  });

  it('detects changed and revoked keys', () => {
    const entries = parseKnownHosts(
      [`example.com ${other.type} ${other.base64}`, `@revoked * ${key.type} ${key.base64}`].join(
        '\n',
      ),
    );
    expect(checkEntries(entries, 'example.com', makeKey()).status).toBe('changed');
    expect(checkEntries(entries, 'example.com', key).status).toBe('revoked');
  });

  it('treats a different key type as unknown and reports known types', () => {
    const ecdsa = makeKey('ecdsa');
    const entries = parseKnownHosts(`example.com ${ecdsa.type} ${ecdsa.base64}`);
    const result = checkEntries(entries, 'example.com', key);
    expect(result).toEqual({ status: 'unknown', knownTypes: ['ecdsa-sha2-nistp256'] });
  });

  it('expands rsa to its signature algorithms', () => {
    expect(preferredHostKeyAlgorithms(['ssh-rsa', 'ssh-ed25519'])).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
      'ssh-ed25519',
    ]);
  });
});

describe('trust store', () => {
  beforeEach(async () => {
    await isolateAppHome();
    vi.spyOn(os, 'homedir').mockReturnValue(await tempDir());
  });

  it('remembers trusted keys and replaces changed ones', async () => {
    const first = makeKey();
    const blob = Buffer.from(first.base64, 'base64');
    expect((await checkHostKey('box', 2200, blob)).status).toBe('unknown');

    await trustHostKey('box', 2200, first);
    expect((await checkHostKey('box', 2200, blob)).status).toBe('trusted');

    const second = makeKey();
    const secondBlob = Buffer.from(second.base64, 'base64');
    expect((await checkHostKey('box', 2200, secondBlob)).status).toBe('changed');

    await trustHostKey('box', 2200, second);
    expect((await checkHostKey('box', 2200, secondBlob)).status).toBe('trusted');
    expect((await checkHostKey('box', 2200, blob)).status).toBe('changed');
  });

  it('reads the system known_hosts file', async () => {
    const key = makeKey();
    const sshDir = path.join(os.homedir(), '.ssh');
    await mkdir(sshDir, { recursive: true });
    await writeFile(path.join(sshDir, 'known_hosts'), `box ${key.type} ${key.base64}\n`);
    expect((await checkHostKey('box', 22, Buffer.from(key.base64, 'base64'))).status).toBe(
      'trusted',
    );
  });
});
