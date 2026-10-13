import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAsset } from '../src/core/keyring.js';
import { deleteSecret, getSecret, secretBackend, setSecret } from '../src/core/secrets.js';
import { isolateAppHome, tempDir } from './helpers/tmp.js';

describe('file secret backend', () => {
  it('encrypts, reads back and deletes secrets', async () => {
    const home = await isolateAppHome();
    expect((await secretBackend()).name).toBe('file');

    await setSecret('host-1', 'password', 'hunter2');
    expect(await getSecret('host-1', 'password')).toBe('hunter2');

    const raw = await readFile(path.join(home, 'vault.json'), 'utf8');
    expect(raw).not.toContain('hunter2');

    await deleteSecret('host-1', 'password');
    expect(await getSecret('host-1', 'password')).toBeUndefined();
  });
});

describe('embedded native addons', () => {
  it('extracts each asset once and repairs a damaged copy', async () => {
    const root = await tempDir();
    const data = new TextEncoder().encode('addon');
    const file = await extractAsset('keyring.node', data, root);
    expect(path.dirname(file)).toBe(path.join(root, 'native'));
    expect(await extractAsset('keyring.node', data, root)).toBe(file);
    await writeFile(file, 'damaged');
    expect(await extractAsset('keyring.node', data, root)).toBe(file);
    expect(await readFile(file, 'utf8')).toBe('addon');
    const other = await extractAsset('keyring.node', new TextEncoder().encode('v2'), root);
    expect(other).not.toBe(file);
  });
});
