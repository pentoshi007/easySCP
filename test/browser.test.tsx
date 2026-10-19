import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renameEntry } from '../src/browser/actions.js';
import { type CopyRecord, Explorer, type ExplorerExit } from '../src/browser/Explorer.js';
import { describeItems, listedEntries, pickTargets, visibleRows } from '../src/browser/model.js';
import { type Pane, usePane } from '../src/browser/usePane.js';
import { localFs } from '../src/fs/local.js';
import { invalidName } from '../src/fs/names.js';
import type { Entry } from '../src/fs/types.js';
import { symbols } from '../src/ui/theme.js';
import { DOWN, ENTER, ESC, renderScreen, TAB, tick, waitFor } from './helpers/ink.js';
import { tempDir } from './helpers/tmp.js';

function entry(name: string, kind: Entry['kind'] = 'file', size = 10): Entry {
  return { name, path: `/root/${name}`, kind, link: false, size, mtime: 0, mode: 0o644 };
}

describe('browser model', () => {
  const entries = [
    entry('src', 'dir'),
    entry('.git', 'dir'),
    entry('readme.md'),
    entry('.env'),
    entry('.big.iso.easyscp-part'),
  ];

  it('hides partial downloads and optionally dotfiles', () => {
    expect(listedEntries(entries, true).pool.map((item) => item.name)).toEqual([
      'src',
      '.git',
      'readme.md',
      '.env',
    ]);
    const hidden = listedEntries(entries, false);
    expect(hidden.pool.map((item) => item.name)).toEqual(['src', 'readme.md']);
    expect(hidden.hidden).toBe(2);
  });

  it('filters fuzzily with match positions', () => {
    const rows = visibleRows(listedEntries(entries, true).pool, 'rdm');
    expect(rows.map((row) => row.entry.name)).toEqual(['readme.md']);
    expect(rows[0]?.positions.length).toBe(3);
  });

  it('acts on the selection or the item under the cursor', () => {
    const [src, , readme] = entries;
    expect(pickTargets(entries, new Set(), readme)).toEqual([readme]);
    expect(pickTargets(entries, new Set([src?.path ?? '']), readme)).toEqual([src]);
    expect(pickTargets(undefined, new Set(), undefined)).toEqual([]);
  });

  it('describes what is about to be touched', () => {
    expect(describeItems([entry('a.txt')])).toBe('a.txt');
    expect(describeItems([entry('a', 'dir')])).toBe('a/');
    expect(describeItems([entry('a'), entry('b')])).toBe('2 files');
    expect(describeItems([entry('a', 'dir'), entry('b', 'dir')])).toBe('2 folders');
    expect(describeItems([entry('a', 'dir'), entry('b')])).toBe('2 items');
  });

  it('validates names', () => {
    expect(invalidName(localFs, '  ')).toBe('Enter a name');
    expect(invalidName(localFs, '..')).toBeDefined();
    expect(invalidName(localFs, 'a/b')).toBeDefined();
    expect(invalidName(localFs, 'report 2024.pdf')).toBeUndefined();
  });
});

describe('renameEntry', () => {
  it('changes only the letter case', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, 'notes.txt'), 'x');
    const [item] = await localFs.list(root);
    await renameEntry(localFs, item as Entry, 'Notes.txt');
    expect((await localFs.list(root)).map((child) => child.name)).toEqual(['Notes.txt']);
  });
});

describe('usePane', () => {
  it('never shows a refreshed listing with a stale cursor', async () => {
    const root = await tempDir();
    await mkdir(path.join(root, 'drafts'));
    await mkdir(path.join(root, 'photos'));
    const seen: (string | undefined)[] = [];
    let pane: Pane | undefined;
    function Probe() {
      pane = usePane({ fs: localFs, label: 'here', start: root, showHidden: false, pageSize: 10 });
      if (pane.entries?.some((entry) => entry.name === 'plans')) seen.push(pane.current?.name);
      return null;
    }
    const app = render(<Probe />);
    await waitFor(() => pane?.current?.name === 'drafts');
    await rename(path.join(root, 'drafts'), path.join(root, 'plans'));
    pane?.refresh('plans');
    await waitFor(() => seen.length > 0);
    await tick(40);
    expect(new Set(seen)).toEqual(new Set(['plans']));
    app.unmount();
  });
});

describe('Explorer', () => {
  let left: string;
  let right: string;

  beforeEach(async () => {
    left = await tempDir();
    right = await tempDir();
    await mkdir(path.join(left, 'photos'));
    await writeFile(path.join(left, 'photos', 'cat.png'), 'meow');
    await writeFile(path.join(left, 'notes.txt'), 'hello');
    await writeFile(path.join(left, 'todo.txt'), 'later');
    await writeFile(path.join(right, 'existing.txt'), 'old');
  });

  async function mount(rows = 24) {
    const onExit = vi.fn<(exit: ExplorerExit) => void>();
    const onCopy = vi.fn<(record: CopyRecord) => Promise<void>>(async () => {});
    const app = renderScreen(
      <Explorer
        title="box"
        sides={[
          { fs: localFs, label: 'here', dir: left },
          { fs: localFs, label: 'there', dir: right },
        ]}
        onCopy={onCopy}
        onExit={onExit}
      />,
      rows,
    );
    await waitFor(() => app.frame().includes('notes.txt') && app.frame().includes('existing.txt'));
    const press = async (...keys: string[]) => {
      for (const value of keys) {
        await tick(40);
        app.stdin.write(value);
      }
      await tick(40);
    };
    const shows = (text: string) =>
      waitFor(() => app.frame().includes(text)).catch(() => {
        throw new Error(`Expected "${text}" in:\n${app.frame()}`);
      });
    return { ...app, onExit, onCopy, press, shows };
  }

  it('shows both sides with counts and details', async () => {
    const view = await mount();
    const frame = view.frame();
    expect(frame).toContain('photos/');
    expect(frame).toContain('3 items');
    expect(frame).toContain('1 item');
    expect(frame).toContain(`photos ${symbols.dot} d`);
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('copies the selection to the other side and records it', async () => {
    const view = await mount();
    await view.press(DOWN, ' ', ' ');
    await view.shows('2 selected');
    await view.press('c');
    await view.shows('Copied 2 files');
    expect(await readFile(path.join(right, 'notes.txt'), 'utf8')).toBe('hello');
    expect(await readFile(path.join(right, 'todo.txt'), 'utf8')).toBe('later');
    expect(view.onCopy).toHaveBeenCalledOnce();
    expect(view.onCopy.mock.calls[0]?.[0]).toMatchObject({
      direction: 'upload',
      destination: right,
    });
  });

  it('asks before replacing existing files', async () => {
    await writeFile(path.join(right, 'notes.txt'), 'stale!');
    const view = await mount();
    await view.press(DOWN, 'c');
    await view.shows('This file already exists in there');
    await view.press(DOWN, ENTER);
    await view.shows('Copied 1 file');
    expect(await readFile(path.join(right, 'notes.txt'), 'utf8')).toBe('hello');
  });

  it('copies folders recursively from the right side to the left', async () => {
    await mkdir(path.join(right, 'logs'));
    await writeFile(path.join(right, 'logs', 'app.log'), 'boot');
    const view = await mount();
    await view.press(TAB);
    await view.shows('logs/');
    await view.press('c');
    await view.shows('Copied 1 file');
    expect(await readFile(path.join(left, 'logs', 'app.log'), 'utf8')).toBe('boot');
    expect(view.onCopy.mock.calls[0]?.[0].direction).toBe('download');
  });

  it('creates, renames and deletes', async () => {
    const view = await mount();
    await view.press('n', 'drafts', ENTER);
    await view.shows('Created drafts/');
    expect((await stat(path.join(left, 'drafts'))).isDirectory()).toBe(true);

    await view.press('r', '\u0015', 'notes.txt', ENTER);
    await view.shows('notes.txt already exists');
    await view.press('\u0015', 'plans', ENTER);
    await view.shows('Renamed drafts to plans');
    expect((await stat(path.join(left, 'plans'))).isDirectory()).toBe(true);

    await view.press('d');
    await view.shows('Delete plans/ from here?');
    await view.press('y');
    await view.shows('Deleted plans/');
    await expect(stat(path.join(left, 'plans'))).rejects.toThrow();
  });

  it('keeps files when deletion is declined', async () => {
    const view = await mount();
    await view.press(DOWN, 'd');
    await view.shows('Delete notes.txt');
    await view.press(ESC);
    await tick(80);
    expect(await readFile(path.join(left, 'notes.txt'), 'utf8')).toBe('hello');
  });

  it('filters, navigates folders and quits with the final folders', async () => {
    const view = await mount();
    await view.press('/', 'cat');
    await view.shows('/cat');
    await view.press(ESC, '/', 'pho', ENTER);
    await view.shows('1 of 3 match /pho');
    await view.press(ENTER);
    await view.shows('cat.png');
    await view.press('q');
    expect(view.onExit).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'quit', dirs: [path.join(left, 'photos'), right] }),
    );
  });

  it('shows one side at a time on narrow terminals', async () => {
    await rm(path.join(right, 'existing.txt'));
    const app = renderScreen(
      <Explorer
        title="box"
        sides={[
          { fs: localFs, label: 'here', dir: left },
          { fs: localFs, label: 'there', dir: right },
        ]}
        onExit={() => {}}
      />,
      20,
    );
    Object.defineProperty(app.stdout, 'columns', { value: 50, configurable: true });
    app.stdout.emit('resize');
    await waitFor(() => app.frame().includes('notes.txt'));
    expect(app.frame()).not.toContain(path.basename(right));
    expect(app.frame()).toContain('tab show there');
    app.stdin.write(TAB);
    await waitFor(() => app.frame().includes('Empty folder'));
    expect(app.frame()).toContain(path.basename(right));
    expect(app.frame()).not.toContain('notes.txt');
  });
});
