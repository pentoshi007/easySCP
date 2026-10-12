import os from 'node:os';
import type { Context } from '../app/context.js';
import { type AuthKind, type Host, hostLabel } from '../core/hosts.js';
import { collapseHome, expandHome, sshDir } from '../core/paths.js';
import { deleteSecret, secretBackend, setSecret } from '../core/secrets.js';
import { localFs } from '../fs/local.js';
import { listPrivateKeys, loadPrivateKey } from '../ssh/keys.js';
import { pickFile } from '../ui/picker/pickers.js';
import type { Choice } from '../ui/prompts/SelectPrompt.js';

export const AUTH_LABELS: Record<AuthKind, string> = {
  auto: 'Automatic',
  key: 'SSH key',
  password: 'Password',
  agent: 'SSH agent',
};

export interface LoginChoice {
  auth: AuthKind;
  identityFile?: string;
  password?: string;
  passphrase?: string;
}

const BROWSE = '\u0000browse';

async function storageHint(): Promise<string> {
  return (await secretBackend()).name === 'keychain'
    ? 'stored in your system keychain'
    : 'stored encrypted on this computer';
}

export async function askAuthKind(ctx: Context, initial: AuthKind = 'auto'): Promise<AuthKind> {
  const storage = await storageHint();
  return ctx.ui.select<AuthKind>('How do you log in?', {
    initial,
    choices: [
      {
        value: 'auto',
        label: AUTH_LABELS.auto,
        hint: 'recommended',
        description: 'Tries your SSH agent and keys in ~/.ssh, then asks for a password if needed.',
      },
      {
        value: 'key',
        label: AUTH_LABELS.key,
        hint: 'choose a private key file',
        description:
          'Use one specific key, like the .pem or .key file your cloud provider gave you.',
      },
      {
        value: 'password',
        label: AUTH_LABELS.password,
        hint: storage,
        description: 'Log in with a password. You can save it or be asked each time.',
      },
      {
        value: 'agent',
        label: AUTH_LABELS.agent,
        hint: 'keys loaded with ssh-add',
        description: 'Only use keys held by your running SSH agent (or Pageant on Windows).',
      },
    ],
  });
}

export async function askKeyFile(ctx: Context, current?: string): Promise<string> {
  const keys = await listPrivateKeys();
  const extra = current && !keys.includes(expandHome(current)) ? [expandHome(current)] : [];
  const files = [...extra, ...keys];
  if (files.length > 0) {
    const choices: Choice<string>[] = files.map((file) => ({
      value: file,
      label: collapseHome(file),
    }));
    choices.push({ value: BROWSE, label: 'Browse for another file…' });
    const picked = await ctx.ui.select('Which key?', {
      choices,
      initial: current ? expandHome(current) : undefined,
    });
    if (picked !== BROWSE) return picked;
  }
  return pickFile(ctx.ui, {
    fs: localFs,
    start: files.length > 0 ? sshDir() : os.homedir(),
    title: 'Choose your private key file',
    action: 'use',
  });
}

export async function askPassphrase(ctx: Context, file: string): Promise<string | undefined> {
  const label = collapseHome(expandHome(file));
  let error: string | undefined;
  for (;;) {
    const passphrase = await ctx.ui.password(`Passphrase for ${label}`, {
      error,
      hint: 'Leave empty to be asked each time you connect',
    });
    if (!passphrase) return undefined;
    const result = await loadPrivateKey(file, passphrase);
    if (result.status === 'ok') return passphrase;
    error = 'Wrong passphrase, try again';
  }
}

export async function chooseKey(ctx: Context, current?: string) {
  for (;;) {
    const identityFile = await askKeyFile(ctx, current);
    const result = await loadPrivateKey(identityFile);
    if (result.status === 'ok') return { identityFile };
    if (result.status === 'encrypted') {
      return { identityFile, passphrase: await askPassphrase(ctx, identityFile) };
    }
    ctx.ui.note(
      result.status === 'invalid'
        ? `Can't use ${collapseHome(identityFile)}: ${result.message}`
        : `Can't read ${collapseHome(identityFile)}`,
      'danger',
    );
  }
}

export async function askLogin(
  ctx: Context,
  host: Pick<Host, 'user' | 'hostname' | 'port'>,
  initial?: AuthKind,
): Promise<LoginChoice> {
  const auth = await askAuthKind(ctx, initial);
  if (auth === 'key') return { auth, ...(await chooseKey(ctx)) };
  if (auth === 'password') {
    const password = await ctx.ui.password(`Password for ${hostLabel(host)}`, {
      hint: `Saved securely (${await storageHint()}). Leave empty to be asked each time.`,
    });
    return { auth, password: password || undefined };
  }
  return { auth };
}

export async function storeLoginSecrets(hostId: string, login: LoginChoice): Promise<void> {
  if (login.password) await setSecret(hostId, 'password', login.password);
  if (login.passphrase) await setSecret(hostId, 'passphrase', login.passphrase);
  if (login.auth !== 'password' && login.auth !== 'auto') await deleteSecret(hostId, 'password');
  if (!login.identityFile) await deleteSecret(hostId, 'passphrase');
}
