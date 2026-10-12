import os from 'node:os';
import type { Context } from '../app/context.js';
import { AppError } from '../core/errors.js';
import {
  createHost,
  type Host,
  listHosts,
  newHostId,
  parseAddress,
  suggestHostName,
  validateHostName,
} from '../core/hosts.js';
import { deleteHostSecrets } from '../core/secrets.js';
import { editHostFields } from './edit.js';
import { askLogin, storeLoginSecrets } from './hostForm.js';
import { done, type Outcome } from './outcome.js';
import { probe } from './test.js';

const ADDRESS_HINT = 'Hostname or IP, optionally with user@ and :port';

export async function addHost(ctx: Context, initialAddress?: string): Promise<Host> {
  const { ui } = ctx;
  const hosts = await listHosts();

  let address = initialAddress ? parseAddress(initialAddress) : undefined;
  if (initialAddress && !address) {
    throw new AppError(
      `"${initialAddress}" is not a valid address`,
      `Use ${ADDRESS_HINT.toLowerCase()}.`,
    );
  }
  if (!address) {
    const raw = await ui.text('Address of the machine', {
      placeholder: 'ubuntu@203.0.113.7 or myserver.com:2222',
      hint: ADDRESS_HINT,
      validate: (value) => (parseAddress(value) ? undefined : `Use ${ADDRESS_HINT.toLowerCase()}`),
    });
    address = parseAddress(raw) as NonNullable<typeof address>;
  }

  const user =
    address.user ??
    (await ui.text('Username on that machine', {
      initial: os.userInfo().username,
      validate: (value) => (/\s/.test(value) ? 'Usernames cannot contain spaces' : undefined),
    }));
  const port = address.port ?? 22;

  const name = await ui.text('Give it a short name', {
    initial: suggestHostName(address.hostname, hosts),
    hint: 'You will use it in commands, e.g. easyscp send <name>',
    validate: (value) => validateHostName(value, hosts),
  });

  const draft = { name, hostname: address.hostname, port, user };
  const login = await askLogin(ctx, draft);
  const id = newHostId();
  const host: Host = {
    ...draft,
    id,
    auth: login.auth,
    createdAt: Date.now(),
    ...(login.identityFile ? { identityFile: login.identityFile } : {}),
  };
  await storeLoginSecrets(id, login);

  try {
    return await verifyAndSave(ctx, host);
  } catch (error) {
    await deleteHostSecrets(id);
    throw error;
  }
}

async function verifyAndSave(ctx: Context, initial: Host): Promise<Host> {
  let host = initial;
  for (;;) {
    const result = await probe(ctx, host);
    if (result.ok) break;
    const next = await ctx.ui.select('What now?', {
      choices: [
        { value: 'retry', label: 'Try again' },
        { value: 'edit', label: 'Change the details' },
        { value: 'save', label: 'Save it anyway', hint: 'fix it later with easyscp edit' },
        { value: 'discard', label: 'Discard' },
      ],
    });
    if (next === 'discard') throw new AppError('Machine was not saved');
    if (next === 'save') break;
    if (next === 'edit') host = await editHostFields(ctx, host, { draft: true });
  }
  const { id, createdAt: _created, lastUsedAt: _used, ...draft } = host;
  return createHost(draft, id);
}

export async function addCommand(ctx: Context): Promise<Outcome> {
  const host = await addHost(ctx, ctx.args.positionals[0]);
  return done(`Saved ${host.name}. Try: easyscp send ${host.name}`);
}
