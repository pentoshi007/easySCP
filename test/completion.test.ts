import { execFile, execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shellNamed } from '../src/completion/detect.js';
import {
  installCompletion,
  setUpCompletionAutomatically,
  uninstallCompletion,
} from '../src/completion/install.js';
import { appFile } from '../src/core/paths.js';
import { completionState, updateCompletionState } from '../src/core/state.js';
import { isolatedEnvironment } from './helpers/env.js';

const run = promisify(execFile);
const windows = process.platform === 'win32';

function available(command: string): boolean {
  if (windows) return false;
  try {
    execFileSync(command, ['-c', 'exit 0'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let home: string;

beforeEach(async () => {
  ({ home } = await isolatedEnvironment());
  vi.stubEnv('ZDOTDIR', '');
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('CI', '');
  vi.stubEnv('EASYSCP_NO_COMPLETION', '');
});

const read = (file: string) => readFile(file, 'utf8');

describe('shellNamed', () => {
  it('recognises shells from paths and process names', () => {
    expect(shellNamed('/bin/zsh')).toBe('zsh');
    expect(shellNamed('-bash\n')).toBe('bash');
    expect(shellNamed('/opt/homebrew/bin/fish')).toBe('fish');
    expect(shellNamed('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(shellNamed('powershell.exe')).toBe('powershell');
    expect(shellNamed('/bin/tcsh')).toBeUndefined();
    expect(shellNamed(undefined)).toBeUndefined();
  });
});

describe('installCompletion', () => {
  it('adds one block to .zshrc and removes it cleanly', async () => {
    const zshrc = path.join(home, '.zshrc');
    const original = 'export EDITOR=vim\nalias ll="ls -l"\n';
    await writeFile(zshrc, original);
    const installed = await installCompletion('zsh');
    await installCompletion('zsh');
    const content = await read(zshrc);
    expect(installed.profiles).toEqual([zshrc]);
    expect(content.startsWith(`${original}\n# >>> easyscp completion >>>`)).toBe(true);
    expect(content.match(/>>> easyscp completion >>>/g)).toHaveLength(1);
    expect(await read(appFile(path.join('completion', 'easyscp.zsh')))).toContain('compdef');

    expect(await uninstallCompletion()).toContain(zshrc);
    expect(await read(zshrc)).toBe(original);
    expect((await completionState()).disabled).toBe(true);
  });

  it('restores profiles exactly, with or without a final newline', async () => {
    const zshrc = path.join(home, '.zshrc');
    for (const original of ['', 'a', 'a\n', 'a\r\nb\r\n']) {
      await writeFile(zshrc, original);
      await installCompletion('zsh');
      await uninstallCompletion('zsh');
      expect(await read(zshrc)).toBe(original);
    }
  });

  it.skipIf(windows)('writes through symlinked dotfiles', async () => {
    const real = path.join(home, 'dotfiles', 'zshrc');
    await mkdir(path.dirname(real), { recursive: true });
    await writeFile(real, '# mine\n');
    await symlink(real, path.join(home, '.zshrc'));
    await installCompletion('zsh');
    expect((await lstat(path.join(home, '.zshrc'))).isSymbolicLink()).toBe(true);
    expect(await read(real)).toContain('easyscp completion');
  });

  it('uses the profile bash reads on this platform', async () => {
    await writeFile(path.join(home, '.profile'), 'PATH=$HOME/bin:$PATH\n');
    const { profiles } = await installCompletion('bash');
    const expected = process.platform === 'darwin' ? '.profile' : '.bashrc';
    expect(profiles).toEqual([path.join(home, expected)]);
    expect(await read(profiles[0] as string)).toContain('$BASH_VERSION');
  });

  it('writes fish completions for both command names and leaves foreign files alone', async () => {
    const dir = path.join(home, '.config', 'fish', 'completions');
    const { files, profiles } = await installCompletion('fish');
    expect(profiles).toEqual([]);
    expect(files).toEqual([path.join(dir, 'easyscp.fish'), path.join(dir, 'escp.fish')]);
    await writeFile(files[1] as string, 'complete -c escp -a mine\n');
    expect(await uninstallCompletion('fish')).toEqual([files[0]]);
    expect(await read(files[1] as string)).toBe('complete -c escp -a mine\n');
  });

  it.skipIf(!available('zsh'))('registers the completion in a real zsh', async () => {
    const { profiles } = await installCompletion('zsh');
    const { stdout } = await run('zsh', ['-c', `source ${profiles[0]}; print $_comps[escp]`], {
      env: { ...process.env, HOME: home },
    });
    expect(stdout.trim()).toBe('_easyscp');
  });

  it.skipIf(!available('bash'))('registers the completion in a real bash', async () => {
    const { profiles } = await installCompletion('bash');
    const { stdout } = await run('bash', ['-c', `. ${profiles[0]}; complete -p escp`], {
      env: { ...process.env, HOME: home },
    });
    expect(stdout).toContain('-F _easyscp');
  });

  it.skipIf(!available('pwsh'))('registers the completion in a real PowerShell', async () => {
    const { profiles } = await installCompletion('powershell');
    expect(profiles).toEqual([path.join(home, '.config', 'powershell', 'profile.ps1')]);
    const script = [
      'function easyscp {}',
      `. '${profiles[0]}'`,
      "(TabExpansion2 -inputScript 'easyscp hist' -cursorColumn 12).CompletionMatches.CompletionText",
    ].join('; ');
    const { stdout } = await run('pwsh', ['-NoLogo', '-NoProfile', '-Command', script], {
      env: { ...process.env, HOME: home },
    });
    expect(stdout.trim()).toBe('history');
  });
});

describe('automatic setup', () => {
  const zsh = async () => 'zsh' as const;

  it('sets up the current shell once and respects opting out', async () => {
    expect((await setUpCompletionAutomatically(zsh))?.shell).toBe('zsh');
    expect(await setUpCompletionAutomatically(zsh)).toBeUndefined();
    await uninstallCompletion();
    expect(await setUpCompletionAutomatically(zsh)).toBeUndefined();
  });

  it('does nothing in CI or when disabled by the environment', async () => {
    vi.stubEnv('CI', 'true');
    expect(await setUpCompletionAutomatically(zsh)).toBeUndefined();
    vi.stubEnv('CI', '');
    vi.stubEnv('EASYSCP_NO_COMPLETION', '1');
    expect(await setUpCompletionAutomatically(zsh)).toBeUndefined();
    expect((await completionState()).shells).toEqual([]);
  });

  it('refreshes installed scripts after an update', async () => {
    const { files } = await installCompletion('zsh');
    await writeFile(files[0] as string, 'stale');
    await updateCompletionState((state) => ({ ...state, version: '0.0.0-old' }));
    expect(await setUpCompletionAutomatically(zsh)).toBeUndefined();
    expect(await read(files[0] as string)).toContain('compdef');
    expect((await completionState()).version).toBe('0.0.0-test');
  });
});
