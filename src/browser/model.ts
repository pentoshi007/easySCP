import { isPartName } from '../fs/names.js';
import { isHidden } from '../fs/ops.js';
import type { Entry } from '../fs/types.js';
import { formatBytes, plural, printable } from '../util/format.js';
import { fuzzyMatch } from '../util/fuzzy.js';

export interface PaneRow {
  entry: Entry;
  positions: number[];
}

export interface Listed {
  pool: Entry[];
  hidden: number;
}

export function listedEntries(entries: Entry[] | undefined, showHidden: boolean): Listed {
  const pool: Entry[] = [];
  let hidden = 0;
  for (const entry of entries ?? []) {
    if (isPartName(entry.name)) continue;
    if (!showHidden && isHidden(entry.name)) hidden++;
    else pool.push(entry);
  }
  return { pool, hidden };
}

export function visibleRows(pool: Entry[], filter: string): PaneRow[] {
  if (!filter.trim()) return pool.map((entry) => ({ entry, positions: [] }));
  const scored: (PaneRow & { score: number })[] = [];
  for (const entry of pool) {
    const match = fuzzyMatch(filter, entry.name);
    if (match) scored.push({ entry, positions: match.positions, score: match.score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ entry, positions }) => ({ entry, positions }));
}

export function pickTargets(
  entries: Entry[] | undefined,
  selected: ReadonlySet<string>,
  current: Entry | undefined,
): Entry[] {
  const chosen = (entries ?? []).filter((entry) => selected.has(entry.path));
  if (chosen.length > 0) return chosen;
  return current ? [current] : [];
}

export function describeItems(entries: Entry[]): string {
  const [first] = entries;
  if (entries.length === 1 && first) {
    return `${printable(first.name)}${first.kind === 'dir' ? '/' : ''}`;
  }
  const dirs = entries.filter((entry) => entry.kind === 'dir').length;
  if (dirs === 0) return plural(entries.length, 'file');
  if (dirs === entries.length) return plural(entries.length, 'folder');
  return plural(entries.length, 'item');
}

export function selectionInfo(entries: Entry[], selected: ReadonlySet<string>): string {
  const chosen = entries.filter((entry) => selected.has(entry.path));
  if (chosen.length === 0) return '';
  const bytes = chosen.reduce(
    (total, entry) => total + (entry.kind === 'file' && entry.size > 0 ? entry.size : 0),
    0,
  );
  return bytes > 0
    ? `${chosen.length} selected, ${formatBytes(bytes)}`
    : `${chosen.length} selected`;
}
