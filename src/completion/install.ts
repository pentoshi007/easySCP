import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../core/errors.js';
import { appDir } from '../core/paths.js';
import { type CompletionState, completionState, updateCompletionState } from '../core/state.js';
import { completionScript, SHELLS, type Shell } from './scripts.js';

const run = promisify(execFile);

const BEGIN = '# >>> easyscp completion >>>';
const END = '# <<< easyscp completion <<<';
const COMMAND_NAMES = ['easyscp', 'escp'];

export interface InstalledCompletion {
  shell: Shell;
  profiles: string[];
  files: string[];
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

function withoutBlock(text: string): string {
  const start = text.indexOf(BEGIN);
  const end = start === -1 ? -1 : text.indexOf(END, start);
  if (end === -1) return text;
  const before = text.slice(0, start).replace(/\r?\n$/, '');
  const after = text.slice(end + END.length).replace(/^\r?\n/, '');
  return before + after;
}

async function replaceText(file: string, text: string): Promise<void> {
  const mode = await stat(file).then(
    (info) => info.mode & 0o777,
    () => 0o644,
  );
  const temp = `${file}.easyscp-${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, text, { mode });
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function writeBlock(profile: string, body: string): Promise<void> {
  const target = await realpath(profile).catch(() => profile);
  const kept = withoutBlock((await readText(target)) ?? '');
  const glue = kept === '' ? '' : '\n';
  await mkdir(path.dirname(target), { recursive: true });
  await replaceText(target, `${kept}${glue}${BEGIN}\n${body}\n${END}\n`);
}

async function removeBlock(profile: string): Promise<boolean> {
  const target = await realpath(profile).catch(() => profile);
  const current = await readText(target);
  if (current === undefined) return false;
  const kept = withoutBlock(current);
  if (kept === current) return false;
  await replaceText(target, kept);
  return true;
}

async function removeOwnFile(file: string): Promise<boolean> {
  const content = await readText(file);
  if (content === undefined || !content.includes('easyscp __hosts')) return false;
  await rm(file, { force: true });
  return true;
}

function posixQuote(file: string): string {
  const portable = process.platform === 'win32' ? file.replaceAll('\\', '/') : file;
  return `'${portable.replaceAll("'", "'\\''")}'`;
}

function powershellQuote(file: string): string {
  return `'${file.replaceAll("'", "''")}'`;
}

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.config');
}

function scriptFiles(shell: Shell): string[] {
  if (shell === 'fish') {
    return COMMAND_NAMES.map((name) =>
      path.join(configHome(), 'fish', 'completions', `${name}.fish`),
    );
  }
  const extension = shell === 'powershell' ? 'ps1' : shell;
  return [path.join(appDir(), 'completion', `easyscp.${extension}`)];
}

function zshProfiles(): string[] {
  const home = os.homedir();
  const zdotdir = process.env.ZDOTDIR;
  return [...new Set([path.join(zdotdir || home, '.zshrc'), path.join(home, '.zshrc')])];
}

const BASH_LOGIN_FILES = ['.bash_profile', '.bash_login', '.profile'];

async function bashProfile(): Promise<string> {
  const home = os.homedir();
  if (process.platform !== 'darwin') return path.join(home, '.bashrc');
  for (const name of BASH_LOGIN_FILES) {
    const file = path.join(home, name);
    if (await exists(file)) return file;
  }
  return path.join(home, '.bash_profile');
}

async function powershellProfiles(): Promise<string[]> {
  const executables = process.platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'];
  const env = process.platform === 'win32' ? process.env : { ...process.env, HOME: os.homedir() };
  const found = await Promise.all(
    executables.map(async (executable) => {
      try {
        const { stdout } = await run(
          executable,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-ExecutionPolicy; $PROFILE.CurrentUserAllHosts',
          ],
          { timeout: 15_000, windowsHide: true, env },
        );
        const [policy, profile] = stdout
          .trim()
          .split(/\r?\n/)
          .map((line) => line.trim());
        if (!profile || policy === 'Restricted' || policy === 'AllSigned') return undefined;
        return profile;
      } catch {
        return undefined;
      }
    }),
  );
  return [...new Set(found.filter((profile) => profile !== undefined))];
}

function loader(shell: Shell, file: string): string {
  switch (shell) {
    case 'zsh': {
      const quoted = posixQuote(file);
      return [
        `if [[ -r ${quoted} ]]; then`,
        '  (( $+functions[compdef] )) || { autoload -Uz compinit && compinit -i; }',
        `  source ${quoted}`,
        'fi',
      ].join('\n');
    }
    case 'bash': {
      const quoted = posixQuote(file);
      return `if [ -n "$BASH_VERSION" ] && [ -r ${quoted} ]; then . ${quoted}; fi`;
    }
    default: {
      const quoted = powershellQuote(file);
      return `if (Test-Path -LiteralPath ${quoted}) { . ${quoted} }`;
    }
  }
}

async function profilesFor(shell: Shell): Promise<string[]> {
  switch (shell) {
    case 'zsh':
      return zshProfiles().slice(0, 1);
    case 'bash':
      return [await bashProfile()];
    case 'powershell': {
      const profiles = await powershellProfiles();
      if (profiles.length === 0) {
        throw new AppError(
          'PowerShell is not available or does not allow profile scripts',
          'Allow local scripts with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, then run `easyscp completion install powershell`.',
        );
      }
      return profiles;
    }
    default:
      return [];
  }
}

async function writeScripts(shell: Shell): Promise<string[]> {
  const files = scriptFiles(shell);
  const script = completionScript(shell);
  for (const file of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, script);
  }
  return files;
}

function remember(state: CompletionState, shell: Shell, profiles: string[]): CompletionState {
  return {
    version: __VERSION__,
    shells: [...new Set([...state.shells, shell])],
    profiles: { ...state.profiles, [shell]: profiles },
    disabled: false,
  };
}

export async function installCompletion(shell: Shell): Promise<InstalledCompletion> {
  const profiles = await profilesFor(shell);
  const files = await writeScripts(shell);
  const [script] = files as [string];
  for (const profile of profiles) await writeBlock(profile, loader(shell, script));
  await updateCompletionState((state) => remember(state, shell, profiles));
  return { shell, profiles, files };
}

async function candidateProfiles(shell: Shell, state: CompletionState): Promise<string[]> {
  const recorded = state.profiles[shell] ?? [];
  switch (shell) {
    case 'zsh':
      return [...recorded, ...zshProfiles()];
    case 'bash':
      return [
        ...recorded,
        ...['.bashrc', ...BASH_LOGIN_FILES].map((name) => path.join(os.homedir(), name)),
      ];
    case 'powershell':
      return recorded.length > 0 ? recorded : powershellProfiles();
    default:
      return recorded;
  }
}

export async function uninstallCompletion(only?: Shell): Promise<string[]> {
  const state = await completionState();
  const shells = only ? [only] : [...SHELLS];
  const changed: string[] = [];
  for (const shell of shells) {
    for (const profile of new Set(await candidateProfiles(shell, state))) {
      if (await removeBlock(profile)) changed.push(profile);
    }
    for (const file of scriptFiles(shell)) {
      if (await removeOwnFile(file)) changed.push(file);
    }
  }
  await updateCompletionState((current) => {
    const profiles = { ...current.profiles };
    for (const shell of shells) delete profiles[shell];
    return {
      version: __VERSION__,
      shells: only ? [...new Set([...current.shells, only])] : [...SHELLS],
      profiles,
      disabled: only === undefined,
    };
  });
  return changed;
}

async function refreshScripts(): Promise<void> {
  for (const shell of SHELLS) {
    for (const file of scriptFiles(shell)) {
      if (await exists(file)) await writeFile(file, completionScript(shell));
    }
  }
}

export function automaticSetupAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.EASYSCP_NO_COMPLETION && !env.CI;
}

export async function setUpCompletionAutomatically(
  detect: () => Promise<Shell | undefined>,
): Promise<InstalledCompletion | undefined> {
  if (!automaticSetupAllowed()) return undefined;
  const state = await completionState();
  if (state.disabled) return undefined;
  if (state.version !== __VERSION__) {
    await refreshScripts();
    await updateCompletionState((current) => ({ ...current, version: __VERSION__ }));
  }
  const shell = await detect();
  if (!shell || state.shells.includes(shell)) return undefined;
  try {
    return await installCompletion(shell);
  } catch {
    await updateCompletionState((current) => ({
      ...current,
      shells: [...new Set([...current.shells, shell])],
    }));
    return undefined;
  }
}
