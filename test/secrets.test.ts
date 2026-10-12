import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteSecret, getSecret, secretBackend, setSecret } from '../src/core/secrets.js';
import { isolateAppHome } from './helpers/tmp.js';

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
