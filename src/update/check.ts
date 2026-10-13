import { saveUpdateState, updateState } from '../core/state.js';
import { compareVersions, latestRelease, type ReleaseOptions } from './release.js';

const CHECK_INTERVAL = 24 * 60 * 60 * 1000;

export function updateChecksAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.EASYSCP_NO_UPDATE_CHECK && !env.CI;
}

export async function availableUpdate(current = __VERSION__): Promise<string | undefined> {
  const { latest } = await updateState();
  return latest && compareVersions(latest, current) > 0 ? latest : undefined;
}

export async function rememberLatest(version: string, now = Date.now()): Promise<void> {
  await saveUpdateState({ checkedAt: now, latest: version });
}

export async function checkForUpdate(
  options: ReleaseOptions & { now?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const state = await updateState();
  const fresh = state.checkedAt > 0 && now >= state.checkedAt;
  if (fresh && now - state.checkedAt < CHECK_INTERVAL) return;
  await saveUpdateState({ ...state, checkedAt: now });
  const release = await latestRelease({
    fetch: options.fetch,
    signal: options.signal ?? AbortSignal.timeout(5000),
  });
  await rememberLatest(release.version, now);
}
