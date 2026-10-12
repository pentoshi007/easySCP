import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readSshConfig, tokenize } from '../src/ssh/sshConfig.js';
import { tempDir } from './helpers/tmp.js';

describe('tokenize', () => {
  it('handles quotes and whitespace', () => {
    expect(tokenize('a  "b c"\td')).toEqual(['a', 'b c', 'd']);
    expect(tokenize('""')).toEqual(['']);
  });
});

describe('readSshConfig', () => {
  let home: string;

  beforeEach(async () => {
    home = await tempDir();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    await mkdir(path.join(home, '.ssh', 'conf.d'), { recursive: true });
  });

  it('resolves hosts with defaults, includes and first-wins semantics', async () => {
    await writeFile(
      path.join(home, '.ssh', 'config'),
      [
        'Include conf.d/*.conf',
        '',
        'Host web',
        '  HostName 10.0.0.5',
        '  User deploy',
        '  Port 2222',
        '  IdentityFile ~/.ssh/web_key',
        '  ProxyJump bastion',
        '',
        'Host bastion',
        '  HostName bastion.example.com',
        '',
        'Host *.internal !skip.internal',
        '  User ops',
        '',
        'Host *',
        '  User fallback',
        '  IdentityFile %d/.ssh/id_default',
      ].join('\n'),
    );
    await writeFile(
      path.join(home, '.ssh', 'conf.d', 'extra.conf'),
      'Host db\n  HostName=db.example.com\n  User "data base"\n',
    );

    const hosts = await readSshConfig();
    const byAlias = Object.fromEntries(hosts.map((host) => [host.alias, host]));
    expect(Object.keys(byAlias).sort()).toEqual(['bastion', 'db', 'web']);
    expect(byAlias.web).toEqual({
      alias: 'web',
      hostname: '10.0.0.5',
      user: 'deploy',
      port: 2222,
      proxyJump: 'bastion',
      identityFiles: [path.join(home, '.ssh', 'web_key'), path.join(home, '.ssh', 'id_default')],
    });
    expect(byAlias.bastion?.user).toBe('fallback');
    expect(byAlias.db).toMatchObject({ hostname: 'db.example.com', user: 'data base' });
  });

  it('returns nothing when there is no config', async () => {
    expect(await readSshConfig()).toEqual([]);
  });
});
