import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, link, lstat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { AppError } from '../core/errors.js';
import type { Release } from './release.js';

const run = promisify(execFile);

export interface DownloadOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number) => void;
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

async function get(url: string, options: DownloadOptions): Promise<Response> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      headers: { 'user-agent': `easyscp/${__VERSION__}` },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AppError(
      "Couldn't download the update",
      'Check your internet connection and try again.',
    );
  }
  if (!response.ok || !response.body) {
    throw new AppError(
      `Couldn't download the update (${response.status} for ${path.basename(url)})`,
    );
  }
  return response;
}

function assetUrl(release: Release, name: string): string {
  const url = release.assets.get(name);
  if (!url) {
    throw new AppError(
      `easyscp ${release.version} has no download for this computer (${name})`,
      'Install it with npm instead: `npm install -g easyscp`.',
    );
  }
  return url;
}

export async function downloadBinary(
  release: Release,
  asset: string,
  destination: string,
  options: DownloadOptions = {},
): Promise<void> {
  const url = assetUrl(release, asset);
  const sums = parseChecksums(await (await get(assetUrl(release, 'SHA256SUMS'), options)).text());
  const expected = sums.get(asset);
  if (!expected) throw new AppError(`The release checksums don't list ${asset}`);

  const response = await get(url, options);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      received += chunk.length;
      options.onProgress?.(received, total);
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream),
      meter,
      createGunzip(),
      createWriteStream(destination, { mode: 0o755 }),
      { signal: options.signal },
    );
    if (hash.digest('hex') !== expected) {
      throw new AppError(
        "The download doesn't match its published checksum",
        'Nothing was changed. Try again, and report it if it keeps happening.',
      );
    }
    await chmod(destination, 0o755);
  } catch (error) {
    await rm(destination, { force: true });
    if (error instanceof AppError || options.signal?.aborted) throw error;
    throw new AppError("Couldn't unpack the update", 'Nothing was changed. Try again.');
  }
}

export async function reportedVersion(executable: string): Promise<string> {
  const { stdout } = await run(executable, ['--version'], {
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, EASYSCP_NO_UPDATE_CHECK: '1' },
  });
  return stdout.trim();
}

export function stagingPath(executable: string, platform: NodeJS.Platform = process.platform) {
  const extension = platform === 'win32' ? '.exe' : '';
  const name = path.basename(executable, extension);
  return path.join(path.dirname(executable), `.${name}-update-${process.pid}${extension}`);
}

export function retiredPath(executable: string): string {
  return `${executable}.old`;
}

const COMMAND_NAMES = ['easyscp', 'escp'];

export function commandAliases(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const extension = platform === 'win32' ? '.exe' : '';
  const same = (a: string, b: string) =>
    platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  return COMMAND_NAMES.map((name) =>
    path.join(path.dirname(executable), `${name}${extension}`),
  ).filter((file) => !same(file, executable));
}

async function relinkAliases(executable: string, platform: NodeJS.Platform): Promise<void> {
  for (const alias of commandAliases(executable, platform)) {
    const info = await lstat(alias).catch(() => undefined);
    if (!info || info.isSymbolicLink()) continue;
    const retired = retiredPath(alias);
    await rm(retired, { force: true });
    await rename(alias, retired);
    await link(executable, alias).catch(() => copyFile(executable, alias));
  }
}

export async function replaceExecutable(
  executable: string,
  next: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') {
    const retired = retiredPath(executable);
    await rm(retired, { force: true });
    await rename(executable, retired);
    try {
      await rename(next, executable);
    } catch (error) {
      await rename(retired, executable);
      throw error;
    }
  } else {
    await rename(next, executable);
  }
  await relinkAliases(executable, platform).catch(() => undefined);
}

export async function removeRetiredExecutable(executable: string): Promise<void> {
  const files = [executable, ...commandAliases(executable)].map(retiredPath);
  await Promise.all(files.map((file) => rm(file, { force: true }).catch(() => undefined)));
}
