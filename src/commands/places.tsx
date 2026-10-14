import os from 'node:os';
import path from 'node:path';
import { Box, Text } from 'ink';
import type { Host } from '../core/hosts.js';
import { recentLocalDirs, recentRemoteDirs } from '../core/state.js';
import { localFs } from '../fs/local.js';
import { displayPath, resolveInput } from '../fs/ops.js';
import type { RemoteFileSystem } from '../fs/remote.js';
import type { FileSystem } from '../fs/types.js';
import type { SkippedItem } from '../transfer/plan.js';
import type { Shortcut } from '../ui/picker/model.js';
import { colors, symbols } from '../ui/theme.js';

const MAX_SHORTCUTS = 5;
export const MAX_LISTED_FAILURES = 5;

async function existingDirs(fs: FileSystem, candidates: (string | undefined)[]): Promise<string[]> {
  const unique = [...new Set(candidates.filter((dir): dir is string => Boolean(dir)))];
  const checks = await Promise.all(
    unique.map(async (dir) => ((await fs.stat(dir))?.kind === 'dir' ? dir : undefined)),
  );
  return checks.filter((dir): dir is string => dir !== undefined);
}

export async function remoteStart(
  fs: RemoteFileSystem,
  host: Host,
): Promise<{ start: string; shortcuts: Shortcut[] }> {
  const configured = host.remoteDir ? resolveInput(fs, host.remoteDir, fs.home) : undefined;
  const recent = await recentRemoteDirs(host.id);
  const dirs = await existingDirs(fs, [configured, ...recent, fs.home]);
  const start = dirs[0] ?? fs.home;
  const shortcuts: Shortcut[] = [];
  if (configured && dirs.includes(configured))
    shortcuts.push({ path: configured, label: 'Default folder' });
  for (const dir of recent) {
    if (shortcuts.length >= MAX_SHORTCUTS) break;
    if (dirs.includes(dir) && !shortcuts.some((entry) => entry.path === dir)) {
      shortcuts.push({ path: dir, label: 'Recent' });
    }
  }
  if (!shortcuts.some((entry) => entry.path === fs.home))
    shortcuts.push({ path: fs.home, label: 'Home' });
  return { start, shortcuts };
}

export async function localStart(host: Host): Promise<{ start: string; shortcuts: Shortcut[] }> {
  const home = os.homedir();
  const named: Shortcut[] = [
    { path: process.cwd(), label: 'Current folder' },
    { path: path.join(home, 'Downloads'), label: 'Downloads' },
    { path: path.join(home, 'Desktop'), label: 'Desktop' },
    { path: home, label: 'Home' },
  ];
  const recent = (await recentLocalDirs()).map((dir) => ({ path: dir, label: 'Recent' }));
  const configured = host.localDir ? [{ path: host.localDir, label: 'Default folder' }] : [];
  const candidates = [...configured, ...recent.slice(0, 3), ...named];
  const valid = new Set(
    await existingDirs(
      localFs,
      candidates.map((entry) => entry.path),
    ),
  );
  const shortcuts: Shortcut[] = [];
  for (const entry of candidates) {
    if (valid.has(entry.path) && !shortcuts.some((existing) => existing.path === entry.path)) {
      shortcuts.push(entry);
    }
  }
  const start = host.localDir && valid.has(host.localDir) ? host.localDir : process.cwd();
  return { start, shortcuts: shortcuts.slice(0, MAX_SHORTCUTS + 1) };
}

export function SkippedList({ fs, items }: { fs: FileSystem; items: SkippedItem[] }) {
  const shown = items.slice(0, MAX_LISTED_FAILURES);
  return (
    <Box flexDirection="column">
      {shown.map((item) => (
        <Text key={item.path} color={colors.muted} wrap="truncate-middle">
          {symbols.dot} {displayPath(fs, item.path)} <Text dimColor>{item.reason}</Text>
        </Text>
      ))}
      {items.length > shown.length ? (
        <Text color={colors.muted}>
          {symbols.ellipsis} and {items.length - shown.length} more
        </Text>
      ) : null}
    </Box>
  );
}
