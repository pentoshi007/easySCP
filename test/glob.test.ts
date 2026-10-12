import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { expandPaths, globToRegExp } from '../src/fs/glob.js';
import { localFs } from '../src/fs/local.js';
import { tempDir } from './helpers/tmp.js';

describe('globToRegExp', () => {
  it('matches shell style patterns', () => {
    expect(globToRegExp('*.log', true).test('app.log')).toBe(true);
    expect(globToRegExp('*.log', true).test('app.LOG')).toBe(false);
    expect(globToRegExp('*.log', false).test('app.LOG')).toBe(true);
    expect(globToRegExp('file?.txt', true).test('file1.txt')).toBe(true);
    expect(globToRegExp('[ab]*', true).test('beta')).toBe(true);
    expect(globToRegExp('[!ab]*', true).test('beta')).toBe(false);
    expect(globToRegExp('a.b', true).test('axb')).toBe(false);
  });
});

describe('expandPaths', () => {
  let root: string;

  beforeAll(async () => {
    root = await tempDir();
    await mkdir(path.join(root, 'logs'));
    for (const name of ['a.log', 'b.log', 'notes.txt', '.hidden.log']) {
      await writeFile(path.join(root, 'logs', name), name);
    }
  });

  it('keeps existing paths and expands globs', async () => {
    const result = await expandPaths(localFs, ['logs/notes.txt', 'logs/*.log'], root);
    expect(result).toEqual([
      path.join(root, 'logs', 'notes.txt'),
      path.join(root, 'logs', 'a.log'),
      path.join(root, 'logs', 'b.log'),
    ]);
  });

  it('includes hidden files only when asked for', async () => {
    expect(await expandPaths(localFs, ['logs/.*.log'], root)).toEqual([
      path.join(root, 'logs', '.hidden.log'),
    ]);
  });

  it('explains missing paths', async () => {
    await expect(expandPaths(localFs, ['nope.txt'], root)).rejects.toThrow(/Not found/);
    await expect(expandPaths(localFs, ['logs/*.zip'], root)).rejects.toThrow(/Nothing matches/);
  });
});
