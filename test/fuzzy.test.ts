import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch } from '../src/util/fuzzy.js';

describe('fuzzyMatch', () => {
  it('matches subsequences and reports positions', () => {
    const match = fuzzyMatch('abc', 'a_b_c');
    expect(match?.positions).toEqual([0, 2, 4]);
  });

  it('rejects non-matches', () => {
    expect(fuzzyMatch('xyz', 'abc')).toBeUndefined();
  });

  it('uses smart case', () => {
    expect(fuzzyMatch('readme', 'README.md')).toBeDefined();
    expect(fuzzyMatch('README', 'readme.md')).toBeUndefined();
  });

  it('requires all space separated terms', () => {
    expect(fuzzyMatch('src cli', 'src/cli.tsx')).toBeDefined();
    expect(fuzzyMatch('src zzz', 'src/cli.tsx')).toBeUndefined();
  });

  it('empty query matches everything', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
  });
});

describe('fuzzyFilter', () => {
  const files = [
    'docs/config/reference.md',
    'src/config.ts',
    'src/core/hosts.ts',
    'test/config.test.ts',
    'node_modules/some/deep/configuration/index.js',
  ];

  it('prefers basename and boundary matches', () => {
    const [first] = fuzzyFilter(files, 'config', (file) => file);
    expect(first?.item).toBe('src/config.ts');
  });

  it('prefers consecutive matches', () => {
    const results = fuzzyFilter(['h_o_s_t_s.ts', 'hosts.ts'], 'hosts', (file) => file);
    expect(results[0]?.item).toBe('hosts.ts');
  });

  it('respects the limit', () => {
    expect(fuzzyFilter(files, 's', (file) => file, 2)).toHaveLength(2);
  });
});
