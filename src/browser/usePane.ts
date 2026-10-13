import { useCallback, useEffect, useMemo, useState } from 'react';
import { parentDir } from '../fs/ops.js';
import type { Entry, FileSystem } from '../fs/types.js';
import { clampCursor, type ListCursor } from '../ui/list.js';
import { cacheFor } from '../ui/picker/cache.js';
import { useListing } from '../ui/picker/hooks.js';
import { listedEntries, type PaneRow, visibleRows } from './model.js';

export interface Pane {
  fs: FileSystem;
  label: string;
  dir: string;
  entries: Entry[] | undefined;
  error: string | undefined;
  rows: PaneRow[];
  listed: number;
  hidden: number;
  cursor: ListCursor;
  current: Entry | undefined;
  selected: ReadonlySet<string>;
  filter: string;
  open(dir: string, focus?: string): void;
  up(): void;
  refresh(focus?: string): void;
  moveTo(index: number): void;
  toggle(entry: Entry): void;
  toggleAll(): void;
  clearSelection(): void;
  setFilter(filter: string): void;
}

interface PaneOptions {
  fs: FileSystem;
  label: string;
  start: string;
  showHidden: boolean;
  pageSize: number;
}

const EMPTY = new Set<string>();

interface Focus {
  name: string;
  stale: Entry[] | undefined;
}

export function usePane({ fs, label, start, showHidden, pageSize }: PaneOptions): Pane {
  const cache = cacheFor(fs);
  const [dir, setDir] = useState(start);
  const [version, setVersion] = useState(0);
  const [raw, setRaw] = useState<ListCursor>({ index: 0, offset: 0 });
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY);
  const [filter, setFilterValue] = useState('');
  const [focus, setFocus] = useState<Focus | undefined>();
  const listing = useListing(cache, dir, version);

  const listed = useMemo(
    () => listedEntries(listing.entries, showHidden),
    [listing.entries, showHidden],
  );
  const rows = useMemo(() => visibleRows(listed.pool, filter), [listed.pool, filter]);
  const settled =
    focus !== undefined && listing.entries !== undefined && listing.entries !== focus.stale;
  const focused = settled ? rows.findIndex((row) => row.entry.name === focus.name) : -1;
  const cursor = clampCursor(
    focused >= 0 ? { ...raw, index: focused } : raw,
    rows.length,
    pageSize,
  );

  useEffect(() => {
    if (!settled) return;
    setFocus(undefined);
    if (focused >= 0) setRaw(cursor);
  }, [settled, focused, cursor]);

  const open = useCallback((next: string, focusName?: string) => {
    setDir(next);
    setRaw({ index: 0, offset: 0 });
    setSelected(EMPTY);
    setFilterValue('');
    setFocus(focusName === undefined ? undefined : { name: focusName, stale: undefined });
  }, []);

  const entries = listing.entries;
  const liveSelection = useMemo(() => {
    if (selected.size === 0 || !entries) return EMPTY;
    const present = new Set(entries.map((entry) => entry.path));
    return new Set([...selected].filter((path) => present.has(path)));
  }, [selected, entries]);

  return {
    fs,
    label,
    dir,
    entries,
    error: listing.error,
    rows,
    listed: listed.pool.length,
    hidden: listed.hidden,
    cursor,
    current: rows[cursor.index]?.entry,
    selected: liveSelection,
    filter,
    open,
    up: () => {
      const parent = parentDir(fs, dir);
      if (parent) open(parent, fs.path.basename(dir));
    },
    refresh: (focusName?: string) => {
      cache.invalidate(dir);
      setVersion((value) => value + 1);
      if (focusName !== undefined) setFocus({ name: focusName, stale: listing.entries });
    },
    moveTo: (index: number) =>
      setRaw((current) => clampCursor({ ...current, index }, rows.length, pageSize)),
    toggle: (entry: Entry) =>
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      }),
    toggleAll: () =>
      setSelected((current) =>
        rows.length > 0 && rows.every((row) => current.has(row.entry.path))
          ? EMPTY
          : new Set(rows.map((row) => row.entry.path)),
      ),
    clearSelection: () => setSelected(EMPTY),
    setFilter: (value: string) => {
      setFilterValue(value);
      setRaw({ index: 0, offset: 0 });
    },
  };
}
