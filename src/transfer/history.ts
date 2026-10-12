import { randomUUID } from 'node:crypto';
import { appFile } from '../core/paths.js';
import { JsonStore } from '../core/store.js';
import type { TransferStatus } from './run.js';

export type Direction = 'upload' | 'download';

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
}

interface HistoryFile {
  version: 1;
  entries: HistoryEntry[];
}

const MAX_ENTRIES = 200;

function isEntry(value: unknown): value is HistoryEntry {
  const entry = value as HistoryEntry;
  return (
    !!entry &&
    typeof entry.id === 'string' &&
    typeof entry.at === 'number' &&
    (entry.direction === 'upload' || entry.direction === 'download') &&
    typeof entry.hostId === 'string' &&
    Array.isArray(entry.sources) &&
    typeof entry.destination === 'string'
  );
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

export async function recordTransfer(entry: Omit<HistoryEntry, 'id' | 'at'>): Promise<void> {
  const full: HistoryEntry = { ...entry, id: randomUUID(), at: Date.now() };
  await store.update((file) => {
    file.entries = [full, ...file.entries].slice(0, MAX_ENTRIES);
    return file;
  });
}

export async function clearHistory(): Promise<void> {
  await store.write({ version: 1, entries: [] });
}

export async function forgetHostHistory(hostId: string): Promise<void> {
  await store.update((file) => {
    file.entries = file.entries.filter((entry) => entry.hostId !== hostId);
    return file;
  });
}
