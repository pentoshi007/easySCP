import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { localFs } from '../src/fs/local.js';
import type { FileSystem } from '../src/fs/types.js';
import { Browser } from '../src/ui/picker/Browser.js';
import { buildRows, splitQuery } from '../src/ui/picker/model.js';
import { rankTop } from '../src/ui/picker/rank.js';
import { parseDroppedPaths } from '../src/util/dropped.js';
import { DOWN, ENTER, ESC, LEFT, RIGHT, strip, TAB, tick, waitFor } from './helpers/ink.js';
import { tempDir } from './helpers/tmp.js';

describe('parseDroppedPaths', () => {
  it('splits escaped and quoted paths', () => {
    expect(parseDroppedPaths('/a/My\\ File.txt /b/c.txt', false)).toEqual([
      '/a/My File.txt',
      '/b/c.txt',
    ]);
    expect(parseDroppedPaths(`'/x y/z' "/q r"`, false)).toEqual(['/x y/z', '/q r']);
  });

  it('keeps windows backslashes and decodes file uris', () => {
    expect(parseDroppedPaths('"C:\\Users\\me\\a b.txt" C:\\x.txt', true)).toEqual([
      'C:\\Users\\me\\a b.txt',
      'C:\\x.txt',
    ]);
    expect(parseDroppedPaths('file:///home/me/a%20b.txt', false)).toEqual(['/home/me/a b.txt']);
  });
});

describe('rankTop', () => {
  it('keeps the best matches in order', () => {
    const items = ['b/u/t/t.txt', 'src/ui/Button.tsx', 'lib/bitter.ts', 'docs/rebuttal.md'];
    const text = (index: number) => items[index] as string;
    const ranked = rankTop(items.length, 'butt', text, (index) => text(index).toLowerCase(), 2);
    expect(ranked).toHaveLength(2);
    expect(items[ranked[0]?.index ?? -1]).toBe('src/ui/Button.tsx');
    expect(ranked.some((entry) => items[entry.index] === 'lib/bitter.ts')).toBe(false);
  });
});

const posixFs = { local: false, label: 'box', path: path.posix, home: '/home/me' } as FileSystem;
const windowsFs = {
  local: true,
  label: 'local',
  path: path.win32,
  home: 'C:\\Users\\me',
} as FileSystem;

describe('picker model', () => {
  it('splits typed paths from filters', () => {
    expect(splitQuery(posixFs, '/srv', 'app')).toEqual({
      dir: '/srv',
      filter: 'app',
      typedPath: false,
    });
    expect(splitQuery(posixFs, '/srv', 'www/ht')).toMatchObject({ dir: '/srv/www', filter: 'ht' });
    expect(splitQuery(posixFs, '/srv', '/etc/')).toMatchObject({ dir: '/etc', filter: '' });
    expect(splitQuery(posixFs, '/srv', '~/').dir).toBe('/home/me');
  });

  it('accepts both separators for local Windows paths', () => {
    expect(splitQuery(windowsFs, 'C:\\srv', 'www\\ht')).toMatchObject({
      dir: 'C:\\srv\\www',
      filter: 'ht',
    });
    expect(splitQuery(windowsFs, 'C:\\srv', 'www/ht')).toMatchObject({
      dir: 'C:\\srv\\www',
      filter: 'ht',
    });
    expect(splitQuery(windowsFs, 'C:\\srv', '~\\')).toMatchObject({ dir: 'C:\\Users\\me' });
  });

  const entry = (name: string, kind: 'file' | 'dir') => ({
    name,
    path: `/base/${name}`,
    kind,
    link: false,
    size: 1,
    mtime: 1,
    mode: 0o644,
  });
  const entries = [entry('apps', 'dir'), entry('notes.txt', 'file'), entry('.cache', 'dir')];

  it('offers choose and create rows when picking folders', () => {
    const view = { dir: '/base', filter: '', typedPath: false };
    const rows = buildRows({
      fs: posixFs,
      mode: 'dir',
      view,
      entries,
      deep: undefined,
      shortcuts: [],
    });
    expect(rows.map((row) => row.kind)).toEqual(['here', 'new', 'entry', 'entry']);

    const filtered = buildRows({
      fs: posixFs,
      mode: 'dir',
      view: { ...view, filter: 'newsite' },
      entries,
      deep: undefined,
      shortcuts: [],
    });
    expect(filtered).toEqual([{ kind: 'create', path: '/base/newsite', name: 'newsite' }]);
  });

  it('dims hidden entries', () => {
    const rows = buildRows({
      fs: posixFs,
      mode: 'files',
      view: { dir: '/base', filter: '', typedPath: false },
      entries,
      deep: undefined,
      shortcuts: [],
    });
    expect(rows.map((row) => (row.kind === 'entry' ? [row.label, row.dim] : null))).toEqual([
      ['apps', false],
      ['notes.txt', false],
      ['.cache', true],
    ]);
  });
});

describe('Browser', () => {
  let root: string;

  beforeAll(async () => {
    root = await tempDir();
    await mkdir(path.join(root, 'photos', 'trip'), { recursive: true });
    await writeFile(path.join(root, 'photos', 'trip', 'beach.jpg'), 'jpg');
    await writeFile(path.join(root, 'photos', 'cat.png'), 'png');
    await writeFile(path.join(root, 'readme.md'), 'readme');
  });

  async function mount(mode: 'files' | 'file' | 'dir') {
    const onSubmit = vi.fn<(paths: string[]) => void>();
    const onCancel = vi.fn();
    const app = render(
      <Browser fs={localFs} start={root} mode={mode} onSubmit={onSubmit} onCancel={onCancel} />,
    );
    const frame = () => strip(app.lastFrame());
    await waitFor(() => !frame().includes('Loading'));
    const press = async (...keys: string[]) => {
      for (const value of keys) {
        app.stdin.write(value);
        await tick(60);
      }
    };
    const shows = (text: string) => waitFor(() => frame().includes(text));
    return { ...app, onSubmit, onCancel, press, frame, shows };
  }

  it('navigates folders and selects multiple files', async () => {
    const view = await mount('files');
    await view.shows('readme.md');
    expect(view.frame()).toContain('photos/');
    await view.press(RIGHT);
    await view.shows('cat.png');
    await view.press(DOWN, ' ', LEFT);
    await view.shows('readme.md');
    expect(view.frame()).toContain('1 selected');
    await view.press('read', TAB, ENTER);
    expect(view.onSubmit).not.toHaveBeenCalled();
    await view.press(ENTER);
    expect(view.onSubmit).toHaveBeenCalledWith([
      path.join(root, 'photos', 'cat.png'),
      path.join(root, 'readme.md'),
    ]);
  });

  it('submits the highlighted file when nothing is selected', async () => {
    const view = await mount('file');
    await view.shows('readme.md');
    await view.press('readme', ENTER);
    expect(view.onSubmit).toHaveBeenCalledWith([path.join(root, 'readme.md')]);
  });

  it('accepts typed paths', async () => {
    const view = await mount('files');
    await view.press('photos/trip/');
    await view.shows('beach.jpg');
    await view.press(ENTER);
    expect(view.onSubmit).toHaveBeenCalledWith([path.join(root, 'photos', 'trip', 'beach.jpg')]);
  });

  it('chooses folders and clears before cancelling', async () => {
    const view = await mount('dir');
    await view.shows('photos/');
    expect(view.frame()).toContain('Use this folder');
    expect(view.frame()).not.toContain('readme.md');
    await view.press('pho', ESC);
    expect(view.onCancel).not.toHaveBeenCalled();
    await view.press(ESC);
    expect(view.onCancel).toHaveBeenCalled();
  });

  it('searches subfolders', async () => {
    const view = await mount('files');
    await view.press('\u0006');
    await view.shows('items indexed');
    await view.press('beach');
    await view.shows('photos/trip/beach.jpg');
  });
});
