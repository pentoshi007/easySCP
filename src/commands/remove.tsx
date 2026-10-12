import type { Context } from '../app/context.js';
import { hostChoice } from '../app/hostPicker.js';
import { AppError } from '../core/errors.js';
import { type Host, listHosts, removeHost, requireHost, sameName } from '../core/hosts.js';
import { deleteHostSecrets } from '../core/secrets.js';
import { forgetHostState } from '../core/state.js';
import { forgetHostHistory } from '../transfer/history.js';
import { plural } from '../util/format.js';
import { done, type Outcome, warn } from './outcome.js';

export async function removeHosts(ctx: Context, targets: Host[]): Promise<boolean> {
  const all = await listHosts();
  const names = targets.map((host) => host.name);
  const dependents = all.filter(
    (host) => host.jump && targets.some((target) => sameName(target.name, host.jump as string)),
  );
  if (!ctx.args.yes) {
    const notice = dependents.length
      ? ` ${dependents.map((host) => host.name).join(', ')} will connect directly afterwards.`
      : '';
    const confirmed = await ctx.ui.confirm(`Remove ${names.join(', ')}?${notice}`, {
      initial: false,
      yes: 'Remove',
      no: 'Keep',
      danger: true,
    });
    if (!confirmed) return false;
  }
  for (const host of targets) {
    ctx.forget(host);
    await removeHost(host.id);
    await Promise.all([
      deleteHostSecrets(host.id),
      forgetHostState(host.id),
      forgetHostHistory(host.id),
    ]);
  }
  return true;
}

export async function removeCommand(ctx: Context): Promise<Outcome> {
  const { positionals } = ctx.args;
  let targets: Host[];
  if (positionals.length > 0) {
    targets = await Promise.all(positionals.map((name) => requireHost(name)));
  } else {
    const hosts = await listHosts();
    if (hosts.length === 0) throw new AppError('No machines saved yet');
    targets = await ctx.ui.multiselect('Which machines should be removed?', {
      choices: hosts.map(hostChoice),
    });
  }
  const removed = await removeHosts(ctx, targets);
  if (!removed) return warn('Nothing was removed');
  return done(`Removed ${plural(targets.length, 'machine')}`);
}
