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
const TOP: Anchor = { index: 0, offset: 0 };

interface Focus {
  name: string;
  after: number;
}

interface Anchor extends ListCursor {
  name?: string;
}

export function usePane({ fs, label, start, showHidden, pageSize }: PaneOptions): Pane {
  const cache = cacheFor(fs);
  const [dir, setDir] = useState(start);
  const [raw, setRaw] = useState<Anchor>(TOP);
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY);
  const [filter, setFilterValue] = useState('');
  const [focus, setFocus] = useState<Focus | undefined>();
  const listing = useListing(cache, dir);

  const listed = useMemo(
    () => listedEntries(listing.entries, showHidden),
    [listing.entries, showHidden],
  );
  const rows = useMemo(() => visibleRows(listed.pool, filter), [listed.pool, filter]);
  const settled =
    focus !== undefined && listing.entries !== undefined && listing.revision > focus.after;
  const focused = settled ? rows.findIndex((row) => row.entry.name === focus.name) : -1;
  const anchored =
    raw.name === undefined ? -1 : rows.findIndex((row) => row.entry.name === raw.name);
  const preferred = focused >= 0 ? focused : anchored >= 0 ? anchored : raw.index;
  const cursor = clampCursor({ index: preferred, offset: raw.offset }, rows.length, pageSize);
  const current = rows[cursor.index]?.entry;

  useEffect(() => {
    if (!settled) return;
    setFocus(undefined);
    if (focused >= 0) setRaw({ ...cursor, name: current?.name });
  }, [settled, focused, cursor, current]);

  const open = useCallback((next: string, focusName?: string) => {
    setDir(next);
    setRaw(TOP);
    setSelected(EMPTY);
    setFilterValue('');
    setFocus(focusName === undefined ? undefined : { name: focusName, after: 0 });
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
    current,
    selected: liveSelection,
    filter,
    open,
    up: () => {
      const parent = parentDir(fs, dir);
      if (parent) open(parent, fs.path.basename(dir));
    },
    refresh: (focusName?: string) => {
      if (focusName !== undefined) setFocus({ name: focusName, after: listing.revision });
      void cache.refresh(dir);
    },
    moveTo: (index: number) =>
      setRaw((previous) => {
        const next = clampCursor({ ...previous, index }, rows.length, pageSize);
        return { ...next, name: rows[next.index]?.entry.name };
      }),
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
      setRaw(TOP);
    },
  };
}
