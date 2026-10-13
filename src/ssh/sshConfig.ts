import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandHome, sshDir } from '../core/paths.js';
import { readText } from '../core/store.js';
import { hasWildcard, matchPatternList, matchWildcard } from './patterns.js';

export interface SshConfigHost {
  alias: string;
  hostname: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  proxyJump?: string;
}

interface Block {
  patterns: string[];
  options: Map<string, string[]>;
}

const MAX_INCLUDE_DEPTH = 8;

export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const char of line) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && (char === ' ' || char === '\t')) {
      if (started) tokens.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) tokens.push(current);
  return tokens;
}

function splitDirective(line: string): [string, string[]] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return undefined;
  const match = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed);
  if (!match) return undefined;
  const [, key = '', rest = ''] = match;
  return [key.toLowerCase(), tokenize(rest)];
}

async function expandInclude(pattern: string, baseDir: string): Promise<string[]> {
  const absolute = path.resolve(baseDir, expandHome(pattern));
  if (!hasWildcard(path.basename(absolute))) return [absolute];
  const dir = path.dirname(absolute);
  const glob = path.basename(absolute);
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => matchWildcard(glob, name))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

async function collectBlocks(file: string, depth: number, blocks: Block[]): Promise<void> {
  if (depth > MAX_INCLUDE_DEPTH) return;
  const text = await readText(file).catch(() => undefined);
  if (!text) return;
  let current: Block | undefined = blocks.at(-1);
  for (const line of text.split(/\r?\n/)) {
    const directive = splitDirective(line);
    if (!directive) continue;
    const [key, values] = directive;
    if (key === 'host') {
      current = { patterns: values, options: new Map() };
      blocks.push(current);
    } else if (key === 'match') {
      current = { patterns: [], options: new Map() };
      blocks.push(current);
    } else if (key === 'include') {
      for (const value of values) {
        for (const included of await expandInclude(value, sshDir())) {
          await collectBlocks(included, depth + 1, blocks);
        }
      }
      current = blocks.at(-1);
    } else {
      if (!current) {
        current = { patterns: ['*'], options: new Map() };
        blocks.push(current);
      }
      const existing = current.options.get(key);
      if (key === 'identityfile') current.options.set(key, [...(existing ?? []), ...values]);
      else if (!existing) current.options.set(key, values);
    }
  }
}

function expandTokens(value: string, alias: string, hostname: string, user: string): string {
  const expanded = expandHome(
    value.replace(/%([%dhunr])/g, (_, token: string) => {
      switch (token) {
        case '%':
          return '%';
        case 'd':
          return os.homedir();
        case 'h':
          return hostname;
        case 'n':
          return alias;
        case 'r':
          return user;
        default:
          return os.userInfo().username;
      }
    }),
  );
  return path.normalize(expanded);
}

function resolve(alias: string, blocks: Block[]): SshConfigHost {
  const options = new Map<string, string[]>();
  for (const block of blocks) {
    if (!matchPatternList(block.patterns, alias)) continue;
    for (const [key, values] of block.options) {
      if (key === 'identityfile') options.set(key, [...(options.get(key) ?? []), ...values]);
      else if (!options.has(key)) options.set(key, values);
    }
  }
  const first = (key: string) => options.get(key)?.[0];
  const hostname = (first('hostname') ?? alias).replace(/%h/g, alias);
  const user = first('user');
  const port = Number(first('port'));
  const proxyJump = first('proxyjump');
  const host: SshConfigHost = {
    alias,
    hostname,
    identityFiles: (options.get('identityfile') ?? []).map((file) =>
      expandTokens(file, alias, hostname, user ?? os.userInfo().username),
    ),
  };
  if (user) host.user = user;
  if (Number.isInteger(port) && port > 0 && port < 65536) host.port = port;
  if (proxyJump && proxyJump.toLowerCase() !== 'none') host.proxyJump = proxyJump;
  return host;
}

export async function readSshConfig(
  file = path.join(sshDir(), 'config'),
): Promise<SshConfigHost[]> {
  const blocks: Block[] = [];
  await collectBlocks(file, 0, blocks);
  const aliases = new Set<string>();
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (!hasWildcard(pattern)) aliases.add(pattern);
    }
  }
  return [...aliases].map((alias) => resolve(alias, blocks));
}
