import { Box, type Key, Text, useInput, usePaste, useWindowSize } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { displayPath, expandInput, parentDir } from '../../fs/ops.js';
import type { Entry, FileSystem } from '../../fs/types.js';
import { parseDroppedPaths } from '../../util/dropped.js';
import { formatBytes, formatRelative, plural } from '../../util/format.js';
import { Highlight } from '../components/Highlight.js';
import { type Hint, KeyHints } from '../components/KeyHints.js';
import { Spinner } from '../components/Spinner.js';
import { clampCursor, type ListCursor, moveCursor } from '../list.js';
import { colors, symbols, type Tone, toneColor } from '../theme.js';
import { cacheFor } from './cache.js';
import { useDeepIndex, useListing } from './hooks.js';
import { buildRows, type PickMode, type Row, rowKey, type Shortcut, splitQuery } from './model.js';

export interface BrowserProps {
  fs: FileSystem;
  start: string;
  mode: PickMode;
  action?: string;
  shortcuts?: Shortcut[];
  onSubmit: (paths: string[]) => void;
  onCancel: () => void;
}

interface Notice {
  text: string;
  tone: Tone;
}

const PREFETCH_DELAY = 120;

function sanitize(input: string): string {
  return Array.from(input)
    .filter((char) => (char.codePointAt(0) ?? 0) >= 32 && char !== '\u007f')
    .join('');
}

function dropLastSegment(query: string): string {
  const trimmed = query.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const word = Math.max(trimmed.lastIndexOf(' '), cut);
  return word < 0 ? '' : query.slice(0, word + 1);
}

function entryColor(entry: Entry): string | undefined {
  if (entry.kind === 'dir') return colors.dir;
  if (entry.link) return colors.link;
  return undefined;
}

function suffix(entry: Entry): string {
  if (entry.kind === 'dir') return '/';
  if (entry.link) return '@';
  return '';
}

export function Browser({
  fs,
  start,
  mode,
  action = 'choose',
  shortcuts = [],
  onSubmit,
  onCancel,
}: BrowserProps) {
  const cache = cacheFor(fs);
  const { columns, rows: height } = useWindowSize();
  const [cwd, setCwd] = useState(start);
  const [query, setQuery] = useState('');
  const [deepOn, setDeepOn] = useState(false);
  const [version, setVersion] = useState(0);
  const [focus, setFocus] = useState<string>();
  const [selected, setSelected] = useState<Map<string, Entry>>(() => new Map());
  const [notice, setNotice] = useState<Notice>();

  const view = useMemo(
    () => (deepOn ? { dir: cwd, filter: query, typedPath: false } : splitQuery(fs, cwd, query)),
    [deepOn, fs, cwd, query],
  );
  const listing = useListing(cache, view.dir, version);
  const deepView = useDeepIndex(fs, cwd, deepOn);
  const deep = deepView?.index;
  const rows = useMemo(
    () => buildRows({ fs, mode, view, entries: listing.entries, deep: deepView, shortcuts }),
    [fs, mode, view, listing.entries, deepView, shortcuts],
  );

  const pageSize = Math.max(4, Math.min(12, height - 10));
  const viewKey = `${deepOn}\u0000${view.dir}\u0000${view.filter}`;
  const [cursorState, setCursorState] = useState({ key: '', index: 0, offset: 0 });
  const focusIndex = focus
    ? rows.findIndex((row) => row.kind === 'entry' && row.entry.path === focus)
    : -1;
  const raw: ListCursor =
    cursorState.key === viewKey
      ? cursorState
      : { index: Math.max(0, focusIndex), offset: Math.max(0, focusIndex - (pageSize >> 1)) };
  const cursor = clampCursor(raw, rows.length, pageSize);
  const setCursor = (next: ListCursor) => setCursorState({ key: viewKey, ...next });
  const current = rows[cursor.index];
  const currentEntry = current?.kind === 'entry' ? current.entry : undefined;

  useEffect(() => {
    if (currentEntry?.kind !== 'dir') return;
    const timer = setTimeout(() => cache.prefetch(currentEntry.path), PREFETCH_DELAY);
    return () => clearTimeout(timer);
  }, [cache, currentEntry]);

  const navigate = (dir: string, from?: string) => {
    setCwd(dir);
    setQuery('');
    setDeepOn(false);
    setFocus(from);
    setNotice(undefined);
  };

  const goUp = () => {
    const base = view.typedPath || deepOn ? view.dir : cwd;
    const parent = parentDir(fs, base);
    if (parent) navigate(parent, base);
    else if (view.typedPath) navigate(base);
  };

  const toggle = (entry: Entry) => {
    if (entry.kind === 'other') {
      setNotice({ text: `${entry.name} is not a regular file`, tone: 'warning' });
      return;
    }
    setSelected((previous) => {
      const next = new Map(previous);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.set(entry.path, entry);
      return next;
    });
  };

  const toggleAll = () => {
    const visible = rows.flatMap((row) =>
      row.kind === 'entry' && row.entry.kind !== 'other' ? [row.entry] : [],
    );
    const all = visible.length > 0 && visible.every((entry) => selected.has(entry.path));
    setSelected((previous) => {
      const next = new Map(previous);
      for (const entry of visible) {
        if (all) next.delete(entry.path);
        else next.set(entry.path, entry);
      }
      return next;
    });
  };

  const activate = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'here' || row.kind === 'create' || row.kind === 'shortcut') {
      onSubmit([row.path]);
      return;
    }
    const { entry } = row;
    if (mode === 'files' && selected.size > 0) {
      onSubmit([...selected.keys()]);
      return;
    }
    if (entry.kind === 'dir') {
      navigate(entry.path);
      return;
    }
    if (mode === 'dir') return;
    if (entry.kind === 'other') {
      setNotice({ text: `${entry.name} is not a regular file`, tone: 'warning' });
      return;
    }
    onSubmit([entry.path]);
  };

  const handleDrop = async (text: string): Promise<boolean> => {
    const windows = fs.local && fs.path.sep === '\\';
    const candidates = parseDroppedPaths(text, windows);
    if (candidates.length === 0) return false;
    const resolved = candidates.map((candidate) => expandInput(fs, candidate));
    if (!resolved.every((candidate) => fs.path.isAbsolute(candidate))) return false;
    const entries = await Promise.all(resolved.map((candidate) => fs.stat(candidate)));
    if (entries.some((entry) => !entry)) return false;
    const found = entries as Entry[];
    const [first] = found;
    if (mode === 'files') {
      setSelected((previous) => {
        const next = new Map(previous);
        for (const entry of found) next.set(entry.path, entry);
        return next;
      });
      setNotice({ text: `Added ${plural(found.length, 'dropped item')}`, tone: 'success' });
    } else if (first?.kind === 'dir') {
      navigate(first.path);
    } else if (first && mode === 'file') {
      onSubmit([first.path]);
    } else if (first) {
      navigate(parentDir(fs, first.path) ?? first.path, first.path);
    }
    return true;
  };

  const typeText = (text: string) => {
    const clean = sanitize(text);
    if (!clean) return;
    setQuery((value) => value + clean);
    setNotice(undefined);
  };

  const receiveText = (text: string) => {
    handleDrop(text).then(
      (dropped) => {
        if (!dropped) typeText(text.replace(/\r?\n/g, ' '));
      },
      () => typeText(text),
    );
  };

  usePaste(receiveText);

  const handleKey = (input: string, key: Key) => {
    const moved = moveCursor(cursor, key, input, rows.length, pageSize);
    if (moved) {
      setCursor(moved);
      return;
    }
    if (key.escape) {
      if (query || deepOn) {
        setQuery('');
        setDeepOn(false);
      } else {
        onCancel();
      }
      return;
    }
    if (key.return) {
      activate(current);
      return;
    }
    if (key.rightArrow) {
      if (currentEntry?.kind === 'dir') navigate(currentEntry.path);
      else if (current?.kind === 'shortcut') navigate(current.path);
      return;
    }
    if (key.leftArrow) {
      goUp();
      return;
    }
    if (key.tab) {
      if (mode === 'files' && currentEntry) {
        toggle(currentEntry);
        const next = moveCursor(cursor, { ...key, downArrow: true }, '', rows.length, pageSize);
        if (next && next.index > cursor.index) setCursor(next);
      } else if (currentEntry?.kind === 'dir') {
        navigate(currentEntry.path);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((value) =>
        key.meta || key.ctrl ? dropLastSegment(value) : Array.from(value).slice(0, -1).join(''),
      );
      return;
    }
    if (key.ctrl) {
      switch (input) {
        case 'f':
          if (!deepOn && view.typedPath) {
            setCwd(view.dir);
            setQuery(view.filter);
          }
          setDeepOn((value) => !value);
          setNotice(undefined);
          return;
        case 'r':
          cache.invalidate(view.dir);
          setVersion((value) => value + 1);
          return;
        case 'a':
          if (mode === 'files') toggleAll();
          return;
        case 'u':
          setQuery('');
          return;
        case 'w':
          setQuery(dropLastSegment);
          return;
        default:
          return;
      }
    }
    if (key.meta) return;
    if (input === ' ' && mode === 'files' && !query) {
      if (currentEntry) toggle(currentEntry);
      return;
    }
    typeText(input);
  };

  useInput(handleKey);

  const wide = columns >= 70;
  const medium = columns >= 50;
  const visible = rows.slice(cursor.offset, cursor.offset + pageSize);
  const location = displayPath(fs, view.dir);
  const loading = !deepOn && !listing.entries && !listing.error;

  let status: { text: string; tone?: Tone; spinner?: boolean } | undefined;
  if (listing.error && !deepOn) status = { text: listing.error, tone: 'danger' };
  else if (notice) status = notice;
  else if (deep) {
    const count = deep.count.toLocaleString();
    if (deep.status === 'running')
      status = { text: `Indexing${symbols.ellipsis} ${count} items`, spinner: true };
    else if (deep.status === 'error')
      status = { text: deep.error ?? 'Search failed', tone: 'danger' };
    else status = { text: `${count} items indexed${deep.truncated ? ' (limit reached)' : ''}` };
  } else if (loading) status = { text: `Loading${symbols.ellipsis}`, spinner: true };
  else if (rows.length === 0) {
    status = {
      text: view.filter
        ? `No matches in this folder ${symbols.dot} ctrl+f searches subfolders`
        : mode === 'dir'
          ? 'No folders here'
          : 'This folder is empty',
    };
  }

  const selectedEntries = [...selected.values()];
  const selectedBytes = selectedEntries.reduce(
    (sum, entry) => sum + (entry.kind === 'file' && entry.size > 0 ? entry.size : 0),
    0,
  );
  const selectedDirs = selectedEntries.filter((entry) => entry.kind === 'dir').length;
  const enterLabel = (() => {
    if (mode === 'files' && selected.size > 0) return `${action} ${selected.size}`;
    if (current?.kind === 'entry' && current.entry.kind === 'dir') return 'open';
    if (mode === 'dir' && current?.kind === 'entry') return 'open';
    return action;
  })();
  const hints: Hint[] = [
    ['↑↓', 'move'],
    ['←→', 'folders'],
  ];
  if (mode === 'files') hints.push([query ? 'tab' : 'space', 'select']);
  hints.push(['enter', enterLabel]);
  hints.push(['ctrl+f', deepOn ? 'browse' : 'search all']);
  hints.push(['esc', query || deepOn ? 'clear' : 'back']);

  return (
    <>
      <Text wrap="truncate-start">
        <Text color={colors.accent}>{fs.local ? 'local' : fs.label}</Text>
        <Text color={colors.muted}>:</Text>
        <Text bold>{location}</Text>
        {deepOn ? <Text color={colors.muted}> {symbols.dot} all subfolders</Text> : null}
      </Text>
      <Text>
        <Text color={deepOn ? colors.warning : colors.accent}>{symbols.pointer} </Text>
        {query ? (
          <Text>
            {query}
            <Text inverse> </Text>
          </Text>
        ) : (
          <Text color={colors.muted}>
            <Text inverse> </Text>
            {deepOn ? ' type to search everything below' : ' type to filter or enter a path'}
          </Text>
        )}
      </Text>
      {cursor.offset > 0 ? (
        <Text color={colors.muted}>
          {'  '}
          {symbols.arrowUp} {cursor.offset} more
        </Text>
      ) : null}
      {visible.map((row, offset) => {
        const active = cursor.offset + offset === cursor.index;
        return (
          <RowView
            key={rowKey(row)}
            row={row}
            active={active}
            mode={mode}
            checked={row.kind === 'entry' && selected.has(row.entry.path)}
            wide={wide}
            medium={medium}
            fs={fs}
          />
        );
      })}
      {cursor.offset + pageSize < rows.length ? (
        <Text color={colors.muted}>
          {'  '}
          {symbols.arrowDown} {rows.length - cursor.offset - pageSize} more
        </Text>
      ) : null}
      {status ? (
        <Text color={status.tone ? toneColor[status.tone] : colors.muted} wrap="truncate-end">
          {status.spinner ? (
            <>
              <Spinner />{' '}
            </>
          ) : null}
          {status.text}
        </Text>
      ) : null}
      {mode === 'files' && selected.size > 0 ? (
        <Text color={colors.success}>
          {symbols.checked} {selected.size} selected
          <Text color={colors.muted}>
            {selectedDirs > 0 ? ` (${plural(selectedDirs, 'folder')})` : ''}
            {selectedBytes > 0 ? ` ${symbols.dot} ${formatBytes(selectedBytes)}` : ''}
          </Text>
        </Text>
      ) : null}
      <KeyHints hints={hints} />
    </>
  );
}

interface RowViewProps {
  row: Row;
  active: boolean;
  mode: PickMode;
  checked: boolean;
  wide: boolean;
  medium: boolean;
  fs: FileSystem;
}

function RowView({ row, active, mode, checked, wide, medium, fs }: RowViewProps) {
  const pointer = (
    <Box flexShrink={0}>
      <Text color={active ? colors.accent : undefined}>{active ? symbols.pointer : ' '} </Text>
    </Box>
  );

  if (row.kind !== 'entry') {
    const [icon, label, color] =
      row.kind === 'here'
        ? [symbols.success, 'Use this folder', colors.success]
        : row.kind === 'create'
          ? ['+', `New folder "${row.name}"`, colors.success]
          : [symbols.arrowRight, row.label, undefined];
    return (
      <Box>
        {pointer}
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            <Text color={active ? colors.accent : color} bold={active}>
              {icon} {label}
            </Text>
            {row.kind === 'here' || row.kind === 'shortcut' ? (
              <Text color={colors.muted}> {displayPath(fs, row.path)}</Text>
            ) : null}
          </Text>
        </Box>
      </Box>
    );
  }

  const { entry } = row;
  const size = entry.kind === 'file' && entry.size >= 0 ? formatBytes(entry.size) : '';
  const age = entry.mtime > 0 ? formatRelative(entry.mtime) : '';
  return (
    <Box>
      {pointer}
      {mode === 'files' ? (
        <Box flexShrink={0}>
          <Text color={checked ? colors.success : colors.muted}>
            {checked ? symbols.checked : symbols.unchecked}{' '}
          </Text>
        </Box>
      ) : null}
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-middle">
          <Highlight
            text={row.label}
            positions={row.positions}
            color={active ? colors.accent : entryColor(entry)}
            bold={active}
            dim={row.dim && !active}
          />
          <Text color={colors.muted}>{suffix(entry)}</Text>
        </Text>
      </Box>
      {medium ? (
        <Box width={10} flexShrink={0} justifyContent="flex-end">
          <Text color={colors.muted}>{size}</Text>
        </Box>
      ) : null}
      {wide ? (
        <Box width={11} flexShrink={0} justifyContent="flex-end">
          <Text color={colors.muted}>{age}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
