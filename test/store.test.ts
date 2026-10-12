import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonStore } from '../src/core/store.js';
import { tempDir } from './helpers/tmp.js';

function counterStore(file: string, strict = false) {
  return new JsonStore<{ count: number }>({
    file: () => file,
    defaults: () => ({ count: 0 }),
    normalize: (raw) => ({ count: Number((raw as { count?: number }).count ?? 0) }),
    strict,
  });
}

describe('JsonStore', () => {
  it('serializes concurrent updates', async () => {
    const store = counterStore(path.join(await tempDir(), 'nested', 'counter.json'));
    await Promise.all(
      Array.from({ length: 25 }, () => store.update((value) => ({ count: value.count + 1 }))),
    );
    expect((await store.read()).count).toBe(25);
  });

  it('falls back to defaults for corrupt optional files', async () => {
    const file = path.join(await tempDir(), 'state.json');
    await writeFile(file, '{oops');
    expect(await counterStore(file).read()).toEqual({ count: 0 });
  });

  it('refuses corrupt strict files', async () => {
    const file = path.join(await tempDir(), 'hosts.json');
    await writeFile(file, '{oops');
    await expect(counterStore(file, true).read()).rejects.toThrow(/Could not read/);
  });
});
