import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { type ParsedKey, utils } from 'ssh2';
import { expandHome, sshDir } from '../core/paths.js';

const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa', 'id_dsa'];
const PRIVATE_KEY_MARKERS = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  '-----BEGIN DSA PRIVATE KEY-----',
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  'PuTTY-User-Key-File-',
];

export type KeyLoadResult =
  | { status: 'ok'; key: ParsedKey; data: Buffer }
  | { status: 'encrypted' }
  | { status: 'bad-passphrase' }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

export function defaultIdentityFiles(): string[] {
  return DEFAULT_KEY_NAMES.map((name) => path.join(sshDir(), name));
}

function looksLikePrivateKey(head: string): boolean {
  return PRIVATE_KEY_MARKERS.some((marker) => head.includes(marker));
}

export async function listPrivateKeys(dir = sshDir()): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const candidates = names.filter(
    (name) => !name.endsWith('.pub') && !name.startsWith('known_hosts') && name !== 'config',
  );
  const checks = await Promise.all(
    candidates.map(async (name) => {
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        if (!info.isFile() || info.size > 64 * 1024) return undefined;
        const head = (await readFile(file, 'utf8')).slice(0, 200);
        return looksLikePrivateKey(head) ? file : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  const keys = checks.filter((file) => file !== undefined);
  const rank = (file: string) => {
    const index = DEFAULT_KEY_NAMES.indexOf(path.basename(file));
    return index < 0 ? DEFAULT_KEY_NAMES.length : index;
  };
  return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function parse(data: Buffer, passphrase?: string): ParsedKey | Error {
  const parsed = utils.parseKey(data, passphrase);
  if (Array.isArray(parsed)) return parsed[0] ?? new Error('No key found');
  return parsed;
}

export async function loadPrivateKey(file: string, passphrase?: string): Promise<KeyLoadResult> {
  let data: Buffer;
  try {
    data = await readFile(expandHome(file));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return { status: 'missing' };
    return { status: 'invalid', message: (error as Error).message };
  }
  const parsed = parse(data, passphrase);
  if (parsed instanceof Error) {
    if (/no passphrase given/i.test(parsed.message)) return { status: 'encrypted' };
    if (/passphrase/i.test(parsed.message)) return { status: 'bad-passphrase' };
    return { status: 'invalid', message: parsed.message };
  }
  if (!parsed.isPrivateKey()) {
    return { status: 'invalid', message: 'This is a public key; choose the private key file' };
  }
  return { status: 'ok', key: parsed, data };
}
