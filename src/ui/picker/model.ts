import { isPartName } from '../../fs/names.js';
import { isHidden, resolveInput } from '../../fs/ops.js';
import type { Entry, FileSystem } from '../../fs/types.js';
import { fuzzyFilter } from '../../util/fuzzy.js';
import type { DeepView } from './hooks.js';
import { rankTop } from './rank.js';

export type PickMode = 'files' | 'file' | 'dir';

export interface Shortcut {
  path: string;
  label: string;
}

export type Row =
  | { kind: 'entry'; entry: Entry; label: string; positions: number[]; dim: boolean }
  | { kind: 'here'; path: string }
  | { kind: 'new'; dir: string }
  | { kind: 'create'; path: string; name: string }
  | { kind: 'shortcut'; path: string; label: string };

export interface ViewQuery {
  dir: string;
  filter: string;
  typedPath: boolean;
}

const DEEP_LIMIT = 200;

export function splitQuery(fs: FileSystem, cwd: string, query: string): ViewQuery {
  const separators = fs.local && fs.path.sep === '\\' ? ['/', '\\'] : ['/'];
  const last = Math.max(...separators.map((separator) => query.lastIndexOf(separator)));
  if (last < 0) return { dir: cwd, filter: query, typedPath: false };
  return {
    dir: resolveInput(fs, query.slice(0, last + 1), cwd),
    filter: query.slice(last + 1),
    typedPath: true,
  };
}

export function rowKey(row: Row): string {
  switch (row.kind) {
    case 'entry':
      return `e:${row.entry.path}`;
    case 'here':
      return 'here';
    case 'new':
      return 'new';
    case 'create':
      return `c:${row.path}`;
    default:
      return `s:${row.path}`;
  }
}

function deepEntry(fs: FileSystem, root: string, relative: string, dir: boolean): Entry {
  const parts = relative.split('/');
  return {
    name: parts.at(-1) ?? relative,
    path: fs.path.join(root, ...parts),
    kind: dir ? 'dir' : 'file',
    link: false,
    size: -1,
    mtime: 0,
    mode: 0,
  };
}

function validFolderName(name: string): boolean {
  return name !== '.' && name !== '..' && !/[\\/]/.test(name) && name.trim() === name;
}

export interface RowsInput {
  fs: FileSystem;
  mode: PickMode;
  view: ViewQuery;
  entries: Entry[] | undefined;
  deep: DeepView | undefined;
  shortcuts: Shortcut[];
}

export function buildRows({
  fs,
  mode,
  view,
  entries,
  deep: deepView,
  shortcuts,
}: RowsInput): Row[] {
  const { dir, filter } = view;
  const rows: Row[] = [];
  const deep = deepView?.index;

  if (deep) {
    const ranked = rankTop(
      deep.count,
      filter,
      (index) => deep.paths[index] as string,
      (index) => deep.lower[index] as string,
      DEEP_LIMIT,
    );
    for (const { index, positions } of ranked) {
      const isDir = deep.dirs[index] as boolean;
      if (mode === 'dir' && !isDir) continue;
      const relative = deep.paths[index] as string;
      rows.push({
        kind: 'entry',
        entry: deepEntry(fs, deep.root, relative, isDir),
        label: relative,
        positions,
        dim: relative.split('/').some(isHidden),
      });
    }
    return rows;
  }

  if (mode === 'dir' && !filter) {
    rows.push({ kind: 'here', path: dir }, { kind: 'new', dir });
    if (!view.typedPath) {
      for (const shortcut of shortcuts) {
        if (shortcut.path !== dir) rows.push({ kind: 'shortcut', ...shortcut });
      }
    }
  }

  const candidates = (entries ?? []).filter(
    (entry) => !isPartName(entry.name) && (mode !== 'dir' || entry.kind === 'dir'),
  );
  for (const { item, positions } of fuzzyFilter(candidates, filter, (entry) => entry.name)) {
    rows.push({
      kind: 'entry',
      entry: item,
      label: item.name,
      positions,
      dim: isHidden(item.name) || item.kind === 'other',
    });
  }

  if (mode === 'dir' && filter && entries && validFolderName(filter)) {
    const exact = entries.some((entry) => entry.name === filter);
    if (!exact) {
      const create: Row = { kind: 'create', path: fs.path.join(dir, filter), name: filter };
      if (rows.length === 0) rows.unshift(create);
      else rows.push(create);
    }
  }
  return rows;
}
