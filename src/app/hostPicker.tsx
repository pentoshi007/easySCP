import { Text } from 'ink';
import type { Context } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { type Host, hostLabel, listHosts, requireHost } from '../core/hosts.js';
import type { Choice } from '../ui/prompts/SelectPrompt.js';
import { colors } from '../ui/theme.js';
import { formatRelative } from '../util/format.js';

const ADD = Symbol('add');

export function hostChoice(host: Host): Choice<Host> {
  return {
    value: host,
    label: host.name,
    hint: `${hostLabel(host)}${host.lastUsedAt ? `  ${formatRelative(host.lastUsedAt)}` : ''}`,
  };
}

export async function chooseHost(
  ctx: Context,
  options: { title: string; name?: string; onAdd?: () => Promise<Host> },
): Promise<Host> {
  if (options.name) return requireHost(options.name);
  const hosts = await listHosts();
  if (hosts.length === 0) {
    if (options.onAdd && ctx.ui.interactive) {
      ctx.ui.note('No machines saved yet. Let’s add one first.');
      return options.onAdd();
    }
    throw new AppError('No machines saved yet', 'Run `easyscp add` to save one.');
  }
  if (hosts.length === 1 && !options.onAdd) {
    const [only] = hosts as [Host];
    return only;
  }
  const choices: Choice<Host | typeof ADD>[] = hosts.map(hostChoice);
  if (options.onAdd)
    choices.push({ value: ADD, label: '+ Add a new machine', color: colors.success });
  const picked = await ctx.ui.select<Host | typeof ADD>(options.title, { choices });
  if (picked === ADD) return (options.onAdd as () => Promise<Host>)();
  return picked;
}

export async function chooseHosts(
  ctx: Context,
  options: { title: string; onAdd?: () => Promise<Host> },
): Promise<Host[]> {
  const hosts = await listHosts();
  if (hosts.length === 0) return [await chooseHost(ctx, options)];
  const choices: Choice<Host | typeof ADD>[] = hosts.map(hostChoice);
  if (options.onAdd)
    choices.push({ value: ADD, label: '+ Add a new machine', color: colors.success });
  const picked = await ctx.ui.multiselect<Host | typeof ADD>(options.title, {
    choices,
    selected: hosts.length === 1 ? hosts : [],
    required: true,
  });
  const chosen = picked.filter((value): value is Host => value !== ADD);
  if (picked.includes(ADD)) {
    const added = await (options.onAdd as () => Promise<Host>)();
    if (!chosen.some((host) => host.id === added.id)) chosen.push(added);
  }
  return chosen;
}

export function HostName({ host }: { host: Host }) {
  return (
    <Text>
      <Text bold>{host.name}</Text>
      <Text color={colors.muted}> {hostLabel(host)}</Text>
    </Text>
  );
}
