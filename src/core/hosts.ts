import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { appFile } from './paths.js';
import { JsonStore } from './store.js';

export const AUTH_KINDS = ['auto', 'agent', 'key', 'password'] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  user: string;
  auth: AuthKind;
  identityFile?: string;
  jump?: string;
  remoteDir?: string;
  localDir?: string;
  createdAt: number;
  lastUsedAt?: number;
}

export type HostDraft = Omit<Host, 'id' | 'createdAt' | 'lastUsedAt'>;

interface HostsFile {
  version: 1;
  hosts: Host[];
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function normalizeHost(raw: unknown): Host | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  const name = optionalString(value.name);
  const hostname = optionalString(value.hostname);
  const user = optionalString(value.user);
  if (!name || !hostname || !user) return undefined;

  const port = Number(value.port ?? 22);
  const auth = AUTH_KINDS.includes(value.auth as AuthKind) ? (value.auth as AuthKind) : 'auto';
  const host: Host = {
    id: optionalString(value.id) ?? randomUUID(),
    name,
    hostname,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 22,
    user,
    auth,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
  };
  const identityFile = optionalString(value.identityFile);
  const jump = optionalString(value.jump);
  const remoteDir = optionalString(value.remoteDir);
  const localDir = optionalString(value.localDir);
  if (identityFile) host.identityFile = identityFile;
  if (jump) host.jump = jump;
  if (remoteDir) host.remoteDir = remoteDir;
  if (localDir) host.localDir = localDir;
  if (typeof value.lastUsedAt === 'number') host.lastUsedAt = value.lastUsedAt;
  return host;
}

const store = new JsonStore<HostsFile>({
  file: () => appFile('hosts.json'),
  defaults: () => ({ version: 1, hosts: [] }),
  strict: true,
  normalize: (raw) => {
    const list = Array.isArray((raw as HostsFile | undefined)?.hosts)
      ? (raw as HostsFile).hosts
      : [];
    return { version: 1, hosts: list.map(normalizeHost).filter((host) => host !== undefined) };
  },
});

function byRecency(a: Host, b: Host): number {
  return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name);
}

export function validateHostName(name: string, hosts: Host[], selfId?: string): string | undefined {
  if (!name) return 'Name is required';
  if (!NAME_PATTERN.test(name)) return 'Use letters, digits, dot, dash or underscore (no spaces)';
  const taken = hosts.some((host) => host.id !== selfId && sameName(host.name, name));
  return taken ? `"${name}" already exists` : undefined;
}

export function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

export function suggestHostName(hostname: string, hosts: Host[]): string {
  const isIp = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  const base = isIp
    ? `server-${hostname.split(/[.:]/).filter(Boolean).at(-1) ?? '1'}`
    : (hostname.split('.')[0] ?? hostname);
  const clean = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'server';
  let candidate = clean.slice(0, 60);
  for (let index = 2; hosts.some((host) => sameName(host.name, candidate)); index++) {
    candidate = `${clean.slice(0, 56)}-${index}`;
  }
  return candidate;
}

export function sanitizeHostName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
}

export function hostLabel(host: Pick<Host, 'user' | 'hostname' | 'port'>): string {
  const hostname = host.hostname.includes(':') ? `[${host.hostname}]` : host.hostname;
  return `${host.user}@${hostname}${host.port === 22 ? '' : `:${host.port}`}`;
}

export interface ParsedAddress {
  user?: string;
  hostname: string;
  port?: number;
}

export function parseAddress(input: string): ParsedAddress | undefined {
  let rest = input.trim().replace(/^ssh:\/\//, '');
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at === 0) return undefined;
  if (at > 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }

  let hostname: string;
  let rawPort: string | undefined;
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) return undefined;
    hostname = rest.slice(1, end);
    const after = rest.slice(end + 1);
    if (after && !after.startsWith(':')) return undefined;
    rawPort = after ? after.slice(1) : undefined;
  } else if (rest.split(':').length > 2) {
    hostname = rest;
  } else {
    [hostname = '', rawPort] = rest.split(':');
  }

  if (!hostname || /[\s/\\@[\]]/.test(hostname)) return undefined;
  const result: ParsedAddress = { hostname };
  if (user) result.user = user;
  if (rawPort !== undefined) {
    if (!/^\d{1,5}$/.test(rawPort)) return undefined;
    const port = Number(rawPort);
    if (port < 1 || port > 65535) return undefined;
    result.port = port;
  }
  return result;
}

export async function listHosts(): Promise<Host[]> {
  const { hosts } = await store.read();
  return hosts.sort(byRecency);
}

export async function findHost(name: string): Promise<Host | undefined> {
  const hosts = await listHosts();
  return hosts.find((host) => sameName(host.name, name));
}

export async function requireHost(name: string): Promise<Host> {
  const hosts = await listHosts();
  const host = hosts.find((entry) => sameName(entry.name, name));
  if (host) return host;
  const close = hosts.find((entry) => entry.name.toLowerCase().startsWith(name.toLowerCase()));
  throw new AppError(
    `No saved machine named "${name}"`,
    close ? `Did you mean "${close.name}"?` : 'Run `easyscp add` to save one, or `easyscp list`.',
  );
}

export function newHostId(): string {
  return randomUUID();
}

export async function createHost(draft: HostDraft, id = newHostId()): Promise<Host> {
  const host = stripEmpty({ ...draft, id, createdAt: Date.now() });
  await store.update((file) => {
    const error = validateHostName(host.name, file.hosts);
    if (error) throw new AppError(error);
    file.hosts.push(host);
    return file;
  });
  return host;
}

export async function updateHost(id: string, patch: Partial<HostDraft>): Promise<Host> {
  let updated: Host | undefined;
  await store.update((file) => {
    const index = file.hosts.findIndex((host) => host.id === id);
    const current = file.hosts[index];
    if (!current) throw new AppError('This machine is no longer saved');
    const next = stripEmpty({ ...current, ...patch });
    const error = validateHostName(next.name, file.hosts, id);
    if (error) throw new AppError(error);
    if (current.name !== next.name) {
      for (const host of file.hosts) {
        if (host.jump && sameName(host.jump, current.name)) host.jump = next.name;
      }
    }
    file.hosts[index] = next;
    updated = next;
    return file;
  });
  return updated as Host;
}

export async function removeHost(id: string): Promise<void> {
  await store.update((file) => {
    const target = file.hosts.find((host) => host.id === id);
    file.hosts = file.hosts.filter((host) => host.id !== id);
    if (target) {
      for (const host of file.hosts) {
        if (host.jump && sameName(host.jump, target.name)) delete host.jump;
      }
    }
    return file;
  });
}

export async function touchHost(id: string): Promise<void> {
  await store.update((file) => {
    const host = file.hosts.find((entry) => entry.id === id);
    if (host) host.lastUsedAt = Date.now();
    return file;
  });
}

function stripEmpty(host: Host): Host {
  const result = { ...host };
  for (const key of ['identityFile', 'jump', 'remoteDir', 'localDir'] as const) {
    if (!result[key]) delete result[key];
  }
  return result;
}
