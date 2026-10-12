import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { appFile, sshDir } from '../core/paths.js';
import { readText, writeFileAtomic } from '../core/store.js';
import { matchPatternList } from './patterns.js';

export type HostKeyStatus = 'trusted' | 'unknown' | 'changed' | 'revoked';

export interface HostKeyInfo {
  type: string;
  base64: string;
  fingerprint: string;
}

export interface HostKeyCheck {
  status: HostKeyStatus;
  key: HostKeyInfo;
  knownTypes: string[];
}

interface KnownHostEntry {
  marker: '@revoked' | '@cert-authority' | undefined;
  hosts: string;
  type: string;
  key: string;
}

const RSA_ALGORITHMS = ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'];

export function knownHostName(hostname: string, port: number): string {
  return port === 22 ? hostname : `[${hostname}]:${port}`;
}

export function describeHostKey(blob: Buffer): HostKeyInfo {
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const type = blob.subarray(4, 4 + length).toString('ascii') || 'unknown';
  const digest = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { type, base64: blob.toString('base64'), fingerprint: `SHA256:${digest}` };
}

export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);
    const marker = fields[0]?.startsWith('@') ? fields.shift() : undefined;
    const [hosts, type, key] = fields;
    if (!hosts || !type || !key) continue;
    if (marker && marker !== '@revoked' && marker !== '@cert-authority') continue;
    entries.push({ marker: marker as KnownHostEntry['marker'], hosts, type, key });
  }
  return entries;
}

function matchesHashed(pattern: string, name: string): boolean {
  const [, magic, salt, hash] = pattern.split('|');
  if (magic !== '1' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function entryMatchesHost(entry: KnownHostEntry, name: string): boolean {
  if (entry.hosts.startsWith('|')) return matchesHashed(entry.hosts, name);
  return matchPatternList(entry.hosts.split(','), name);
}

export function checkEntries(entries: KnownHostEntry[], name: string, key: HostKeyInfo) {
  let trusted = false;
  let changed = false;
  const knownTypes = new Set<string>();
  for (const entry of entries) {
    if (entry.marker === '@cert-authority' || !entryMatchesHost(entry, name)) continue;
    const sameKey = entry.key === key.base64;
    if (entry.marker === '@revoked') {
      if (sameKey) return { status: 'revoked' as const, knownTypes: [] };
      continue;
    }
    knownTypes.add(entry.type);
    if (sameKey) trusted = true;
    else if (entry.type === key.type) changed = true;
  }
  const status: HostKeyStatus = trusted ? 'trusted' : changed ? 'changed' : 'unknown';
  return { status, knownTypes: [...knownTypes] };
}

function ownFile(): string {
  return appFile('known_hosts');
}

function systemFiles(): string[] {
  return [path.join(sshDir(), 'known_hosts'), path.join(sshDir(), 'known_hosts2')];
}

async function loadEntries(files: string[]): Promise<KnownHostEntry[]> {
  const texts = await Promise.all(files.map((file) => readText(file).catch(() => undefined)));
  return texts.flatMap((text) => (text ? parseKnownHosts(text) : []));
}

export async function checkHostKey(
  hostname: string,
  port: number,
  blob: Buffer,
): Promise<HostKeyCheck> {
  const key = describeHostKey(blob);
  const entries = await loadEntries([ownFile(), ...systemFiles()]);
  const result = checkEntries(entries, knownHostName(hostname, port), key);
  return { ...result, key };
}

export async function knownKeyTypes(hostname: string, port: number): Promise<string[]> {
  const name = knownHostName(hostname, port);
  const entries = await loadEntries([ownFile(), ...systemFiles()]);
  const types = new Set<string>();
  for (const entry of entries) {
    if (!entry.marker && entryMatchesHost(entry, name)) types.add(entry.type);
  }
  return [...types];
}

export function preferredHostKeyAlgorithms(types: string[]): string[] {
  return types.flatMap((type) => (type === 'ssh-rsa' ? RSA_ALGORITHMS : [type]));
}

export async function trustHostKey(
  hostname: string,
  port: number,
  key: HostKeyInfo,
): Promise<void> {
  const name = knownHostName(hostname, port);
  const file = ownFile();
  const text = (await readText(file)) ?? '';
  const kept = text.split(/\r?\n/).filter((line) => {
    const [entry] = parseKnownHosts(line);
    return line.trim() && !(entry && entry.type === key.type && entryMatchesHost(entry, name));
  });
  kept.push(`${name} ${key.type} ${key.base64}`);
  await writeFileAtomic(file, `${kept.join('\n')}\n`);
}
