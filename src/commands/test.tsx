import { Text } from 'ink';
import type { Context } from '../app/context.js';
import { chooseHost } from '../app/hostPicker.js';
import { describeError, InterruptedError } from '../core/errors.js';
import { type Host, hostLabel } from '../core/hosts.js';
import { displayPath } from '../fs/ops.js';
import { colors, symbols } from '../ui/theme.js';
import { formatDuration } from '../util/format.js';
import { done, fail, type Outcome } from './outcome.js';

export interface ProbeResult {
  ok: boolean;
  message: string;
  hint?: string;
}

export async function probe(ctx: Context, host: Host): Promise<ProbeResult> {
  ctx.forget(host);
  const started = performance.now();
  try {
    const fs = await ctx.connect(host);
    const elapsed = formatDuration(performance.now() - started);
    const details = [
      hostLabel(host),
      `logged in ${elapsed}`,
      `home ${displayPath(fs, fs.home)}`,
      fs.session.serverSoftware,
    ].filter(Boolean);
    ctx.ui.step(
      <Text color={colors.success}>Connected to {host.name}</Text>,
      <Text color={colors.muted}>{details.join(` ${symbols.dot} `)}</Text>,
      'success',
    );
    return { ok: true, message: `${host.name} is ready` };
  } catch (error) {
    if (error instanceof InterruptedError) throw error;
    const report = describeError(error);
    ctx.ui.step(
      <Text color={colors.danger}>Could not connect to {host.name}</Text>,
      <>
        <Text>{report.message}</Text>
        {report.hint ? <Text color={colors.muted}>{report.hint}</Text> : null}
      </>,
      'danger',
    );
    return { ok: false, message: report.message, hint: report.hint };
  }
}

export async function testCommand(ctx: Context): Promise<Outcome> {
  const host = await chooseHost(ctx, {
    title: 'Which machine should I test?',
    name: ctx.args.positionals[0],
  });
  const result = await probe(ctx, host);
  return result.ok ? done(result.message) : fail(`${host.name} is not reachable`);
}
