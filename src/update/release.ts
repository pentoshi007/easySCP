import { AppError } from '../core/errors.js';

export const REPOSITORY = 'pentoshi007/easySCP';

export interface Release {
  version: string;
  assets: Map<string, string>;
}

export interface ReleaseOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

function parts(version: string): { core: number[]; pre: string[] } {
  const clean = version.trim().replace(/^v/, '').split('+', 1)[0] ?? '';
  const dash = clean.indexOf('-');
  const core = dash === -1 ? clean : clean.slice(0, dash);
  const pre = dash === -1 ? '' : clean.slice(dash + 1);
  return {
    core: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
    pre: pre ? pre.split('.') : [],
  };
}

function compareIdentifiers(a: string, b: string): number {
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a)) return -1;
  if (numeric.test(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.core.length, right.core.length, 3); index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return Math.sign(right.pre.length - left.pre.length);
  }
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const [x, y] = [left.pre[index], right.pre[index]];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const difference = compareIdentifiers(x, y);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function releasesApi(): string {
  return process.env.EASYSCP_RELEASES_API || `https://api.github.com/repos/${REPOSITORY}/releases`;
}

export function binaryAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const system = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform as string];
  if (!system || (arch !== 'x64' && arch !== 'arm64')) return undefined;
  return `easyscp-${system}-${arch}${system === 'windows' ? '.exe' : ''}.gz`;
}

const unreachable = () =>
  new AppError(
    "Couldn't reach GitHub to check for updates",
    'Check your internet connection and try again.',
  );

export async function latestRelease(options: ReleaseOptions = {}): Promise<Release> {
  const request = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await request(`${releasesApi()}/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `easyscp/${__VERSION__}`,
      },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw unreachable();
  }
  if (response.status === 404) throw new AppError('No easyscp release has been published yet');
  if (!response.ok) {
    throw new AppError(
      `Couldn't check for updates (GitHub answered ${response.status})`,
      response.status === 403 || response.status === 429
        ? 'GitHub limits how often you can ask. Try again in an hour.'
        : 'Try again later.',
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    tag_name?: unknown;
    assets?: { name?: unknown; browser_download_url?: unknown }[];
  };
  if (typeof body.tag_name !== 'string') throw unreachable();
  const assets = new Map<string, string>();
  for (const asset of Array.isArray(body.assets) ? body.assets : []) {
    if (typeof asset.name === 'string' && typeof asset.browser_download_url === 'string') {
      assets.set(asset.name, asset.browser_download_url);
    }
  }
  return { version: body.tag_name.replace(/^v/, ''), assets };
}
