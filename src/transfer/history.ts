import { randomUUID } from 'node:crypto';
import { appFile } from '../core/paths.js';
import { JsonStore } from '../core/store.js';
import type { TransferStatus } from './run.js';

export type Direction = 'upload' | 'download' | 'copy';

export interface HistoryTarget {
  hostId: string;
  hostName: string;
  destination: string;
  status: TransferStatus;
}

export interface HistoryEntry {
  id: string;
  at: number;
  direction: Direction;
  hostId: string;
  hostName: string;
  sources: string[];
  destination: string;
  files: number;
  bytes: number;
  durationMs: number;
  status: TransferStatus;
  error?: string;
  targets?: HistoryTarget[];
}

interface HistoryFile {
  version: 1;
  entries: HistoryEntry[];
}

const MAX_ENTRIES = 200;

const DIRECTIONS = new Set<unknown>(['upload', 'download', 'copy']);

function isTarget(value: unknown): value is HistoryTarget {
  const target = value as HistoryTarget;
  return (
    !!target &&
    typeof target.hostId === 'string' &&
    typeof target.hostName === 'string' &&
    typeof target.destination === 'string'
  );
}

function isEntry(value: unknown): value is HistoryEntry {
  const entry = value as HistoryEntry;
  return (
    !!entry &&
    typeof entry.id === 'string' &&
    typeof entry.at === 'number' &&
    DIRECTIONS.has(entry.direction) &&
    typeof entry.hostId === 'string' &&
    Array.isArray(entry.sources) &&
    typeof entry.destination === 'string' &&
    (entry.direction !== 'copy' || (Array.isArray(entry.targets) && entry.targets.every(isTarget)))
  );
}

function sameList<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): boolean {
  return a.length === b.length && a.every((item, index) => same(item, b[index] as T));
}

const store = new JsonStore<HistoryFile>({
  file: () => appFile('history.json'),
  defaults: () => ({ version: 1, entries: [] }),
  normalize: (raw) => {
    const entries = (raw as HistoryFile | undefined)?.entries;
    return { version: 1, entries: Array.isArray(entries) ? entries.filter(isEntry) : [] };
  },
});

export async function listHistory(): Promise<HistoryEntry[]> {
  return (await store.read()).entries;
}

function sameTransfer(a: Omit<HistoryEntry, 'id' | 'at'>, b: HistoryEntry): boolean {
  return (
    a.direction === b.direction &&
    a.hostId === b.hostId &&
    a.destination === b.destination &&
    sameList(a.sources, b.sources, (x, y) => x === y) &&
    sameList(
      a.targets ?? [],
      b.targets ?? [],
      (x, y) => x.hostId === y.hostId && x.destination === y.destination,
    )
  );
}

export async function recordTransfer(entry: Omit<HistoryEntry, 'id' | 'at'>): Promise<void> {
  const full: HistoryEntry = { ...entry, id: randomUUID(), at: Date.now() };
  await store.update((file) => {
    const others = file.entries.filter((existing) => !sameTransfer(entry, existing));
    file.entries = [full, ...others].slice(0, MAX_ENTRIES);
    return file;
  });
}

export async function clearHistory(): Promise<void> {
  await store.write({ version: 1, entries: [] });
}

export async function forgetHostHistory(hostId: string): Promise<void> {
  await store.update((file) => {
    file.entries = file.entries.flatMap((entry) => {
      if (entry.direction === 'upload' && entry.targets?.length) {
        const targets = entry.targets.filter((target) => target.hostId !== hostId);
        const [first] = targets;
        if (!first) return [];
        return [
          {
            ...entry,
            hostId: first.hostId,
            hostName: first.hostName,
            destination: first.destination,
            targets,
          },
        ];
      }
      if (entry.hostId === hostId) return [];
      if (!entry.targets) return [entry];
      const targets = entry.targets.filter((target) => target.hostId !== hostId);
      return targets.length > 0 ? [{ ...entry, targets }] : [];
    });
    return file;
  });
}
