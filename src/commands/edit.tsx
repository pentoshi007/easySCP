import type { Context } from '../app/context.js';
import { chooseHost } from '../app/hostPicker.js';
import { wentBack } from '../core/errors.js';
import {
  type Host,
  type HostDraft,
  hostLabel,
  listHosts,
  parseAddress,
  sameName,
  updateHost,
  validateHostName,
} from '../core/hosts.js';
import { collapseHome } from '../core/paths.js';
import { deleteSecret, getSecret, setSecret } from '../core/secrets.js';
import { localFs } from '../fs/local.js';
import { displayPath } from '../fs/ops.js';
import { pickDirectory } from '../ui/picker/pickers.js';
import type { Choice } from '../ui/prompts/SelectPrompt.js';
import { colors } from '../ui/theme.js';
import { AUTH_LABELS, askAuthKind, chooseKey } from './hostForm.js';
import { done, type Outcome } from './outcome.js';
import { probe } from './test.js';

type Field =
  | 'name'
  | 'address'
  | 'auth'
  | 'key'
  | 'password'
  | 'jump'
  | 'remoteDir'
  | 'localDir'
  | 'test'
  | 'done';

const NONE = '\u0000none';
const CHOOSE = '\u0000choose';

async function editOnce(ctx: Context, host: Host, field: Field): Promise<Partial<HostDraft>> {
  const { ui } = ctx;
  switch (field) {
    case 'name': {
      const hosts = await listHosts();
      const name = await ui.text('New name', {
        initial: host.name,
        validate: (value) => validateHostName(value, hosts, host.id),
      });
      return { name };
    }
    case 'address': {
      const value = await ui.text('Address', {
        initial: hostLabel(host),
        hint: 'user@host or user@host:port',
        validate: (input) => (parseAddress(input) ? undefined : 'Use user@host or user@host:port'),
      });
      const parsed = parseAddress(value);
      if (!parsed) return {};
      return { hostname: parsed.hostname, user: parsed.user ?? host.user, port: parsed.port ?? 22 };
    }
    case 'auth': {
      const auth = await askAuthKind(ctx, host.auth);
      if (auth === 'key' && !host.identityFile) {
        const { identityFile, passphrase } = await chooseKey(ctx);
        if (passphrase) await setSecret(host.id, 'passphrase', passphrase);
        return { auth, identityFile };
      }
      if (auth === 'password' && !(await getSecret(host.id, 'password'))) {
        await editOnce(ctx, { ...host, auth }, 'password');
      }
      return { auth };
    }
    case 'key': {
      const { identityFile, passphrase } = await chooseKey(ctx, host.identityFile);
      if (passphrase) await setSecret(host.id, 'passphrase', passphrase);
      else await deleteSecret(host.id, 'passphrase');
      return { identityFile };
    }
    case 'password': {
      const password = await ui.password(`Password for ${hostLabel(host)}`, {
        hint: 'Leave empty to forget the saved password and be asked each time',
      });
      if (password) await setSecret(host.id, 'password', password);
      else await deleteSecret(host.id, 'password');
      return {};
    }
    case 'jump': {
      const others = (await listHosts()).filter(
        (other) => other.id !== host.id && !sameName(other.jump ?? '', host.name),
      );
      const choices: Choice<string>[] = [
        { value: NONE, label: 'Connect directly', hint: 'no jump host' },
        ...others.map((other) => ({
          value: other.name,
          label: other.name,
          hint: hostLabel(other),
        })),
      ];
      const jump = await ui.select('Connect through which machine?', {
        choices,
        initial: host.jump ?? NONE,
        emptyText: 'Save the jump host as a machine first',
      });
      return { jump: jump === NONE ? undefined : jump };
    }
    case 'remoteDir': {
      const choice = await ui.select('Default folder on the server', {
        choices: [
          { value: NONE, label: 'Home folder' },
          { value: CHOOSE, label: 'Choose a folder on the server…' },
        ],
        initial: host.remoteDir ? CHOOSE : NONE,
      });
      if (choice === NONE) return { remoteDir: undefined };
      const fs = await ctx.connect(host);
      const start = host.remoteDir ? host.remoteDir.replace(/^~(?=\/|$)/, fs.home) : fs.home;
      const remoteDir = await pickDirectory(ui, {
        fs,
        start,
        title: `Default folder on ${host.name}`,
        action: 'set default',
      });
      return { remoteDir: remoteDir === fs.home ? undefined : remoteDir };
    }
    case 'localDir': {
      const choice = await ui.select('Default folder on this computer', {
        choices: [
          { value: NONE, label: 'Wherever I run easyscp', hint: 'current folder' },
          { value: CHOOSE, label: 'Choose a folder…' },
        ],
        initial: host.localDir ? CHOOSE : NONE,
      });
      if (choice === NONE) return { localDir: undefined };
      const localDir = await pickDirectory(ui, {
        fs: localFs,
        start: host.localDir ?? process.cwd(),
        title: 'Default local folder',
        action: 'set default',
      });
      return { localDir };
    }
    default:
      return {};
  }
}

async function fieldChoices(host: Host): Promise<Choice<Field>[]> {
  const hasPassword = Boolean(await getSecret(host.id, 'password'));
  const choices: Choice<Field>[] = [
    { value: 'name', label: 'Name', hint: host.name },
    { value: 'address', label: 'Address', hint: hostLabel(host) },
    { value: 'auth', label: 'Login method', hint: AUTH_LABELS[host.auth] },
  ];
  if (host.auth === 'key' || host.auth === 'auto') {
    choices.push({
      value: 'key',
      label: 'Key file',
      hint: host.identityFile
        ? collapseHome(host.identityFile)
        : host.auth === 'auto'
          ? 'any in ~/.ssh'
          : 'none',
    });
  }
  if (host.auth === 'password' || host.auth === 'auto') {
    choices.push({
      value: 'password',
      label: 'Saved password',
      hint: hasPassword ? 'saved' : 'ask each time',
    });
  }
  choices.push(
    { value: 'jump', label: 'Jump host', hint: host.jump ?? 'none' },
    { value: 'remoteDir', label: 'Default remote folder', hint: host.remoteDir ?? 'home' },
    {
      value: 'localDir',
      label: 'Default local folder',
      hint: host.localDir ? displayPath(localFs, host.localDir) : 'current folder',
    },
    { value: 'test', label: 'Test connection', color: colors.accent },
    { value: 'done', label: 'Done', color: colors.success },
  );
  return choices;
}

export async function editHostFields(
  ctx: Context,
  initial: Host,
  options: { draft?: boolean } = {},
): Promise<Host> {
  let host = initial;
  let last: Field = 'name';
  for (;;) {
    const field: Field = await ctx.ui
      .select<Field>(`Edit ${host.name}`, {
        choices: await fieldChoices(host),
        initial: last,
        filter: false,
      })
      .catch((error: unknown) => {
        if (wentBack(error)) return 'done' satisfies Field;
        throw error;
      });
    if (field === 'done') return host;
    last = field;
    if (field === 'test') {
      await probe(ctx, host);
      continue;
    }
    try {
      const patch = await editOnce(ctx, host, field);
      if (Object.keys(patch).length === 0) continue;
      host = options.draft
        ? stripUndefined({ ...host, ...patch })
        : await updateHost(host.id, patch);
      if (field === 'address' || field === 'auth' || field === 'key' || field === 'jump') {
        ctx.forget(host);
      }
    } catch (error) {
      if (!wentBack(error)) throw error;
    }
  }
}

function stripUndefined(host: Host): Host {
  return Object.fromEntries(
    Object.entries(host).filter(([, value]) => value !== undefined),
  ) as unknown as Host;
}

export async function editCommand(ctx: Context): Promise<Outcome> {
  const host = await chooseHost(ctx, {
    title: 'Which machine do you want to edit?',
    name: ctx.args.positionals[0],
  });
  const updated = await editHostFields(ctx, host);
  return done(`Saved changes to ${updated.name}`);
}
