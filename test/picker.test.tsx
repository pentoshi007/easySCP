import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { render } from 'ink-testing-library';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { localFs } from '../src/fs/local.js';
import { Browser } from '../src/ui/picker/Browser.js';
import { buildRows, splitQuery } from '../src/ui/picker/model.js';
import { rankTop } from '../src/ui/picker/rank.js';
import { parseDroppedPaths } from '../src/util/dropped.js';
import { DOWN, ENTER, ESC, LEFT, RIGHT, strip, TAB, tick } from './helpers/ink.js';
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

describe('picker model', () => {
  it('splits typed paths from filters', () => {
    expect(splitQuery(localFs, '/srv', 'app')).toEqual({
      dir: '/srv',
      filter: 'app',
      typedPath: false,
    });
    expect(splitQuery(localFs, '/srv', 'www/ht')).toMatchObject({ dir: '/srv/www', filter: 'ht' });
    expect(splitQuery(localFs, '/srv', '/etc/')).toMatchObject({ dir: '/etc', filter: '' });
    expect(splitQuery(localFs, '/srv', '~/').dir).toBe(localFs.home);
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
      fs: localFs,
      mode: 'dir',
      view,
      entries,
      deep: undefined,
      shortcuts: [],
    });
    expect(rows.map((row) => row.kind)).toEqual(['here', 'entry', 'entry']);

    const filtered = buildRows({
      fs: localFs,
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
      fs: localFs,
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
    await tick(80);
    const press = async (...keys: string[]) => {
      for (const value of keys) {
        app.stdin.write(value);
        await tick(60);
      }
    };
    return { ...app, onSubmit, onCancel, press, frame: () => strip(app.lastFrame()) };
  }

  it('navigates folders and selects multiple files', async () => {
    const view = await mount('files');
    expect(view.frame()).toContain('photos/');
    expect(view.frame()).toContain('readme.md');
    await view.press(RIGHT);
    expect(view.frame()).toContain('cat.png');
    await view.press(DOWN, ' ', LEFT);
    expect(view.frame()).toContain('1 selected');
    await view.press('read', TAB, ENTER);
    expect(view.onSubmit).toHaveBeenCalledWith([
      path.join(root, 'photos', 'cat.png'),
      path.join(root, 'readme.md'),
    ]);
  });

  it('submits the highlighted file when nothing is selected', async () => {
    const view = await mount('file');
    await view.press('readme', ENTER);
    expect(view.onSubmit).toHaveBeenCalledWith([path.join(root, 'readme.md')]);
  });

  it('accepts typed paths', async () => {
    const view = await mount('files');
    await view.press('photos/trip/');
    expect(view.frame()).toContain('beach.jpg');
    await view.press(ENTER);
    expect(view.onSubmit).toHaveBeenCalledWith([path.join(root, 'photos', 'trip', 'beach.jpg')]);
  });

  it('chooses folders and clears before cancelling', async () => {
    const view = await mount('dir');
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
    await tick(200);
    await view.press('beach');
    expect(view.frame()).toContain('photos/trip/beach.jpg');
    expect(view.frame()).toContain('items indexed');
  });
});
