import { describe, expect, it } from 'vitest';
import { findCommand, parseCommandLine, suggestCommand } from '../src/cli/args.js';
import { renderHelp } from '../src/cli/help.js';
import { parseCopyTokens, parseSendTokens } from '../src/commands/copyArgs.js';
import { completionScript } from '../src/completion/scripts.js';
import type { Host } from '../src/core/hosts.js';
import { colorsDisabled } from '../src/ui/theme.js';

describe('parseCommandLine', () => {
  it('resolves commands and aliases', () => {
    const parsed = parseCommandLine(['get', 'prod', '/var/log', '-t', './logs', '--newer']);
    expect(parsed.command?.name).toBe('receive');
    expect(parsed.positionals).toEqual(['prod', '/var/log']);
    expect(parsed.to).toBe('./logs');
    expect(parsed.policy).toBe('newer');
  });

  it('keeps unknown words for host lookup', () => {
    const parsed = parseCommandLine(['prod']);
    expect(parsed.command).toBeUndefined();
    expect(parsed.word).toBe('prod');
  });

  it('rejects unknown and misplaced options', () => {
    expect(() => parseCommandLine(['--nope'])).toThrow(/Unknown option --nope/);
    expect(() => parseCommandLine(['list', '--to', 'x'])).toThrow(/can't be used with list/);
    expect(() => parseCommandLine(['send', '--skip', '--overwrite'])).toThrow(/only one/);
  });

  it('accepts global flags anywhere', () => {
    expect(parseCommandLine(['send', '-y']).yes).toBe(true);
    expect(parseCommandLine(['--help', 'send']).help).toBe(true);
  });
});

describe('parseCopyTokens', () => {
  const machine = (name: string) => ({ id: `id-${name}`, name }) as Host;
  const hosts = ['web1', 'web2', 'web3'].map(machine);
  const parse = (...tokens: string[]) => {
    const request = parseCopyTokens(tokens, hosts);
    return {
      source: request.source?.name,
      paths: request.paths,
      destinations: request.destinations.map((entry) => `${entry.host.name}=${entry.dir ?? ''}`),
    };
  };

  it('reads machine:path pairs like scp', () => {
    expect(parse('web1:/srv/app.tar', 'web2', 'web3:/opt')).toEqual({
      source: 'web1',
      paths: ['/srv/app.tar'],
      destinations: ['web2=', 'web3=/opt'],
    });
  });

  it('accepts paths after the source machine and repeated sources', () => {
    expect(parse('web1', 'logs/', 'web1:etc/app.conf', 'web2')).toEqual({
      source: 'web1',
      paths: ['logs/', 'etc/app.conf'],
      destinations: ['web2='],
    });
    expect(parse('WEB1:a', 'web2', 'web2')).toMatchObject({ destinations: ['web2='] });
  });

  it('explains mistakes', () => {
    expect(() => parse('nope:/x', 'web2')).toThrow(/No saved machine named "nope"/);
    expect(() => parse('web1:/x', 'nope:/y')).toThrow(/No saved machine named "nope"/);
    expect(() => parse('web1:/x', 'web2', 'stray')).toThrow(/"stray" is not a saved machine/);
    expect(() => parse('web1:/x', 'web1')).toThrow(/copying from/);
    expect(parse()).toEqual({ source: undefined, paths: [], destinations: [] });
  });
});

describe('parseSendTokens', () => {
  const machine = (name: string) => ({ id: `id-${name}`, name }) as Host;
  const hosts = ['web1', 'web2'].map(machine);
  const local = new Set(['./dist', 'C:\\build', 'notes:2024.txt']);
  const parse = async (...tokens: string[]) => {
    const request = await parseSendTokens(tokens, hosts, async (token) => local.has(token));
    return {
      paths: request.paths,
      destinations: request.destinations.map((entry) => `${entry.host.name}=${entry.dir ?? ''}`),
    };
  };

  it('takes machines and files in any order', async () => {
    expect(await parse('web1', './dist')).toEqual({ paths: ['./dist'], destinations: ['web1='] });
    expect(await parse('./dist', 'web1', 'web2:/srv')).toEqual({
      paths: ['./dist'],
      destinations: ['web1=', 'web2=/srv'],
    });
    expect(await parse('WEB1:', './dist', 'web1', 'web1:/a', 'web1:/a')).toEqual({
      paths: ['./dist'],
      destinations: ['web1=', 'web1=/a'],
    });
  });

  it('keeps local paths that only look like machine:path', async () => {
    expect(await parse('C:\\build', 'web1')).toMatchObject({ paths: ['C:\\build'] });
    expect(await parse('notes:2024.txt', 'web1')).toMatchObject({ paths: ['notes:2024.txt'] });
    expect(await parse('D:\\missing', 'web1')).toMatchObject({ paths: ['D:\\missing'] });
    await expect(parse('./dist', 'wbe1:/srv')).rejects.toThrow(/No saved machine named "wbe1"/);
  });
});

describe('command lookup', () => {
  it('suggests close matches', () => {
    expect(findCommand('UP')?.name).toBe('send');
    expect(suggestCommand('sned')).toBe('send');
    expect(suggestCommand('recieve')).toBe('receive');
    expect(suggestCommand('zzzzzz')).toBeUndefined();
  });
});

describe('help and completion', () => {
  it('renders plain help without escape codes', () => {
    const help = renderHelp(false);
    expect(help).toContain('send, up');
    expect(help).not.toContain('\u001B');
    expect(renderHelp(false, findCommand('send'))).toContain('--resume');
  });

  it('honours NO_COLOR unless colour is forced', () => {
    expect(colorsDisabled({ NO_COLOR: '1' })).toBe(true);
    expect(colorsDisabled({ NO_COLOR: '' })).toBe(false);
    expect(colorsDisabled({ NO_COLOR: '1', FORCE_COLOR: '1' })).toBe(false);
  });

  it('runs the zsh completion when autoloaded from fpath', () => {
    const script = completionScript('zsh');
    expect(script.startsWith('#compdef easyscp escp')).toBe(true);
    expect(script).toContain('_easyscp "$@"');
  });

  it('generates completion scripts for every shell', () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell'] as const) {
      const script = completionScript(shell);
      expect(script).toContain('__hosts');
      expect(script).toContain('receive');
      expect(script).toMatch(/copy.+cp.+relay/);
    }
  });
});
