import { beforeEach, describe, expect, it } from 'vitest';
import {
  createHost,
  findHost,
  hostLabel,
  listHosts,
  parseAddress,
  removeHost,
  requireHost,
  updateHost,
  validateHostName,
} from '../src/core/hosts.js';
import { isolateAppHome } from './helpers/tmp.js';

describe('parseAddress', () => {
  it.each([
    ['example.com', { hostname: 'example.com' }],
    ['root@example.com', { user: 'root', hostname: 'example.com' }],
    ['root@example.com:2222', { user: 'root', hostname: 'example.com', port: 2222 }],
    ['10.0.0.5:22', { hostname: '10.0.0.5', port: 22 }],
    ['me@[fe80::1]:2200', { user: 'me', hostname: 'fe80::1', port: 2200 }],
    ['::1', { hostname: '::1' }],
    ['ssh://deploy@box', { user: 'deploy', hostname: 'box' }],
  ])('parses %s', (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it.each(['', '@host', 'host:abc', 'host:70000', 'bad host', 'a/b'])('rejects %j', (input) => {
    expect(parseAddress(input)).toBeUndefined();
  });
});

describe('hostLabel', () => {
  it('omits the default port and brackets ipv6', () => {
    expect(hostLabel({ user: 'u', hostname: 'h', port: 22 })).toBe('u@h');
    expect(hostLabel({ user: 'u', hostname: '::1', port: 2222 })).toBe('u@[::1]:2222');
  });
});

describe('host store', () => {
  beforeEach(async () => {
    await isolateAppHome();
  });

  const draft = {
    name: 'prod',
    hostname: 'example.com',
    port: 22,
    user: 'root',
    auth: 'auto' as const,
  };

  it('creates, finds and lists hosts', async () => {
    const host = await createHost(draft);
    expect(host.id).toBeTruthy();
    expect((await findHost('PROD'))?.id).toBe(host.id);
    expect(await listHosts()).toHaveLength(1);
  });

  it('rejects duplicate and invalid names', async () => {
    await createHost(draft);
    await expect(createHost(draft)).rejects.toThrow(/already exists/);
    expect(validateHostName('has space', [])).toMatch(/letters/);
    expect(validateHostName('a:b', [])).toBeDefined();
  });

  it('renames and keeps jump references in sync', async () => {
    const bastion = await createHost({ ...draft, name: 'bastion' });
    await createHost({ ...draft, name: 'app', jump: 'bastion' });
    await updateHost(bastion.id, { name: 'gateway' });
    expect((await findHost('app'))?.jump).toBe('gateway');
    await removeHost(bastion.id);
    expect((await findHost('app'))?.jump).toBeUndefined();
  });

  it('suggests close names', async () => {
    await createHost(draft);
    await expect(requireHost('pro')).rejects.toMatchObject({ hint: 'Did you mean "prod"?' });
  });
});

describe('suggestHostName', () => {
  it('derives readable unique names', async () => {
    const { suggestHostName } = await import('../src/core/hosts.js');
    expect(suggestHostName('prod.example.com', [])).toBe('prod');
    expect(suggestHostName('10.0.0.5', [])).toBe('server-5');
    const taken = [{ name: 'prod' }] as never[];
    expect(suggestHostName('prod.example.com', taken)).toBe('prod-2');
  });
});
