import { createHash } from 'node:crypto';
import { link, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/app/main.js';
import { updateState } from '../src/core/state.js';
import {
  commandAliases,
  downloadBinary,
  parseChecksums,
  removeRetiredExecutable,
  replaceExecutable,
  reportedVersion,
  retiredPath,
  stagingPath,
} from '../src/update/binary.js';
import { availableUpdate, checkForUpdate } from '../src/update/check.js';
import { installMethod } from '../src/update/method.js';
import {
  binaryAssetName,
  compareVersions,
  latestRelease,
  type Release,
} from '../src/update/release.js';
import { isolatedEnvironment } from './helpers/env.js';
import { tempDir } from './helpers/tmp.js';

beforeEach(async () => {
  await isolatedEnvironment();
});

function routes(table: Record<string, () => Response>): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const route = table[url];
    if (!route) return new Response('missing', { status: 404 });
    return route();
  }) as unknown as typeof fetch;
}

const API = 'https://api.github.com/repos/pentoshi007/easySCP/releases/latest';
const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });

describe('compareVersions', () => {
  it('orders releases and prereleases like semver', () => {
    const ordered = [
      '0.1.0',
      '0.1.1',
      '0.2.0-beta.2',
      '0.2.0-beta.10',
      '0.2.0-rc.1',
      '0.2.0',
      '1.0.0',
    ];
    for (let index = 1; index < ordered.length; index++) {
      expect(compareVersions(ordered[index] as string, ordered[index - 1] as string)).toBe(1);
      expect(compareVersions(ordered[index - 1] as string, ordered[index] as string)).toBe(-1);
    }
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
  });
});

describe('installMethod', () => {
  it('tells how easyscp was installed', () => {
    const facts = (sea: boolean, file: string) => ({ sea, executable: file, script: file });
    expect(installMethod(facts(true, '/opt/homebrew/Cellar/easyscp/0.2.0/bin/easyscp'))).toEqual({
      kind: 'homebrew',
    });
    expect(
      installMethod(facts(true, '/home/linuxbrew/.linuxbrew/Cellar/easyscp/0.2.0/bin/easyscp')),
    ).toEqual({ kind: 'homebrew' });
    expect(installMethod(facts(true, '/home/me/.local/bin/easyscp'))).toEqual({
      kind: 'binary',
      executable: '/home/me/.local/bin/easyscp',
    });
    expect(
      installMethod(
        facts(
          false,
          'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@pentoshi\\easyscp\\dist\\cli.js',
        ),
      ),
    ).toEqual({ kind: 'npm' });
    expect(
      installMethod(facts(false, '/usr/lib/node_modules/@pentoshi/easyscp/dist/cli.js')),
    ).toEqual({
      kind: 'npm',
    });
    expect(installMethod(facts(false, '/home/me/src/easySCP/dist/cli.js'))).toEqual({
      kind: 'source',
    });
  });
});

describe('releases', () => {
  it('names the download for each platform', () => {
    expect(binaryAssetName('darwin', 'arm64')).toBe('easyscp-darwin-arm64.gz');
    expect(binaryAssetName('linux', 'x64')).toBe('easyscp-linux-x64.gz');
    expect(binaryAssetName('win32', 'arm64')).toBe('easyscp-windows-arm64.exe.gz');
    expect(binaryAssetName('freebsd', 'x64')).toBeUndefined();
    expect(binaryAssetName('linux', 'ia32')).toBeUndefined();
  });

  it('reads the latest release from GitHub', async () => {
    const fetch = routes({
      [API]: json({
        tag_name: 'v0.3.0',
        assets: [{ name: 'SHA256SUMS', browser_download_url: 'https://x/SHA256SUMS' }, {}],
      }),
    });
    const release = await latestRelease({ fetch });
    expect(release.version).toBe('0.3.0');
    expect([...release.assets]).toEqual([['SHA256SUMS', 'https://x/SHA256SUMS']]);
  });

  it('explains failures', async () => {
    await expect(latestRelease({ fetch: routes({ [API]: json({}, 403) }) })).rejects.toThrow(
      /GitHub answered 403/,
    );
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(latestRelease({ fetch: offline })).rejects.toThrow(/Couldn't reach GitHub/);
  });

  it('checks at most once a day and remembers the newest version', async () => {
    const fetch = routes({ [API]: json({ tag_name: 'v9.0.0', assets: [] }) });
    const start = Date.UTC(2026, 0, 1);
    const hour = 60 * 60 * 1000;
    await checkForUpdate({ fetch, now: start });
    await checkForUpdate({ fetch, now: start + hour });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await updateState()).toEqual({ checkedAt: start, latest: '9.0.0' });
    expect(await availableUpdate('8.9.9')).toBe('9.0.0');
    expect(await availableUpdate('9.0.0')).toBeUndefined();
    await checkForUpdate({ fetch, now: start + 25 * hour });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('binary updates', () => {
  const content = Buffer.from('#!/bin/sh\necho new\n');
  const packed = gzipSync(content);
  const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const release = (sums: string): { release: Release; fetch: typeof fetch } => ({
    release: {
      version: '0.3.0',
      assets: new Map([
        ['SHA256SUMS', 'https://x/SHA256SUMS'],
        ['easyscp-linux-x64.gz', 'https://x/easyscp-linux-x64.gz'],
      ]),
    },
    fetch: routes({
      'https://x/SHA256SUMS': () => new Response(sums),
      'https://x/easyscp-linux-x64.gz': () =>
        new Response(packed, { headers: { 'content-length': String(packed.length) } }),
    }),
  });

  it('parses checksum files', () => {
    const hex = 'a'.repeat(64);
    expect(parseChecksums(`${hex}  one.gz\r\n${hex.toUpperCase()} *two.gz\nnoise\n`)).toEqual(
      new Map([
        ['one.gz', hex],
        ['two.gz', hex],
      ]),
    );
  });

  it('downloads, verifies and unpacks the new binary', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'next');
    const { release: latest, fetch } = release(`${sha(packed)}  easyscp-linux-x64.gz\n`);
    const progress: number[] = [];
    await downloadBinary(latest, 'easyscp-linux-x64.gz', target, {
      fetch,
      onProgress: (received) => progress.push(received),
    });
    expect(await readFile(target)).toEqual(content);
    expect(progress.at(-1)).toBe(packed.length);
    if (process.platform !== 'win32') expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  it('refuses a download that does not match its checksum', async () => {
    const dir = await tempDir();
    const target = path.join(dir, 'next');
    const { release: latest, fetch } = release(`${'0'.repeat(64)}  easyscp-linux-x64.gz\n`);
    await expect(downloadBinary(latest, 'easyscp-linux-x64.gz', target, { fetch })).rejects.toThrow(
      /doesn't match its published checksum/,
    );
    await expect(stat(target)).rejects.toThrow();
    await expect(
      downloadBinary(latest, 'easyscp-darwin-arm64.gz', target, { fetch }),
    ).rejects.toThrow(/no download for this computer/);
  });

  it('runs the new binary to confirm its version', async () => {
    expect(await reportedVersion(process.execPath)).toBe(process.version);
  });

  it.each(['linux', 'win32'] as const)('replaces the executable on %s', async (platform) => {
    const dir = await tempDir();
    const executable = path.join(dir, platform === 'win32' ? 'easyscp.exe' : 'easyscp');
    const next = stagingPath(executable, platform);
    expect(path.dirname(next)).toBe(dir);
    await writeFile(executable, 'old');
    await writeFile(next, 'new');
    await replaceExecutable(executable, next, platform);
    expect(await readFile(executable, 'utf8')).toBe('new');
    await expect(stat(next)).rejects.toThrow();
    if (platform === 'win32') expect(await readFile(retiredPath(executable), 'utf8')).toBe('old');
  });

  it('keeps a hard-linked alias pointing at the new binary', async () => {
    const dir = await tempDir();
    const executable = path.join(dir, 'easyscp');
    const alias = path.join(dir, 'escp');
    expect(commandAliases(executable, 'linux')).toEqual([alias]);
    expect(commandAliases(path.join(dir, 'ESCP.EXE'), 'win32')).toEqual([
      path.join(dir, 'easyscp.exe'),
    ]);
    await writeFile(executable, 'old');
    await link(executable, alias);
    const next = stagingPath(executable, 'linux');
    await writeFile(next, 'new');
    await replaceExecutable(executable, next, 'linux');
    expect(await readFile(alias, 'utf8')).toBe('new');
    await removeRetiredExecutable(executable, 'linux');
    await expect(stat(retiredPath(alias))).rejects.toThrow();
  });
});

describe('update command', () => {
  let output: string;
  let errors: string;

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

  it('says when easyscp is up to date', async () => {
    vi.stubGlobal('fetch', routes({ [API]: json({ tag_name: 'v0.0.0-test', assets: [] }) }));
    expect(await main(['update'])).toBe(0);
    expect(output).toMatch(/easyscp 0.0.0-test is up to date/);
  });

  it('explains how to update a copy built from source', async () => {
    vi.stubGlobal('fetch', routes({ [API]: json({ tag_name: 'v0.3.0', assets: [] }) }));
    expect(await main(['upgrade'])).toBe(1);
    expect(errors).toMatch(/easyscp 0.3.0 is available/);
    expect(errors).toMatch(/git pull/);
    expect((await updateState()).latest).toBe('0.3.0');
  });
});
