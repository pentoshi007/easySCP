import { Box, Text } from 'ink';
import type { Context } from '../app/context.js';
import { AppError } from '../core/errors.js';
import { listHosts } from '../core/hosts.js';
import { localFs } from '../fs/local.js';
import { displayPath } from '../fs/ops.js';
import { clearHistory, type HistoryEntry, listHistory } from '../transfer/history.js';
import type { Choice } from '../ui/prompts/SelectPrompt.js';
import { colors, symbols } from '../ui/theme.js';
import { formatBytes, formatRelative, plural, printable, truncateMiddle } from '../util/format.js';
import { done, type Outcome, warn } from './outcome.js';
import { transferFlow } from './transfer.js';

const STATUS_COLOR: Record<HistoryEntry['status'], string> = {
  done: colors.success,
  partial: colors.warning,
  failed: colors.danger,
  cancelled: colors.warning,
};

function baseName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? value;
}

export function describeEntry(entry: HistoryEntry): { label: string; hint: string } {
  const arrow = entry.direction === 'upload' ? symbols.arrowUp : symbols.arrowDown;
  const [first] = entry.sources;
  const what = first
    ? `${printable(baseName(first))}${entry.sources.length > 1 ? ` +${entry.sources.length - 1}` : ''}`
    : 'nothing';
  const destination =
    entry.direction === 'upload'
      ? `${entry.hostName}:${entry.destination}`
      : displayPath(localFs, entry.destination);
  const label = `${arrow} ${what} ${symbols.arrowRight} ${truncateMiddle(destination, 48)}`;
  const amount =
    entry.files > 0
      ? `${plural(entry.files, 'file')} ${symbols.dot} ${formatBytes(entry.bytes)}`
      : entry.status === 'done'
        ? 'nothing new'
        : '';
  const parts = [
    `${entry.direction === 'upload' ? 'to' : 'from'} ${entry.hostName}`,
    entry.status === 'done' ? '' : entry.status,
    amount,
    formatRelative(entry.at),
  ];
  return { label, hint: parts.filter(Boolean).join(` ${symbols.dot} `) };
}

function HistoryTable({ entries }: { entries: HistoryEntry[] }) {
  return (
    <Box flexDirection="column">
      {entries.map((entry) => {
        const { label, hint } = describeEntry(entry);
        return (
          <Text key={entry.id} wrap="truncate-end">
            <Text color={STATUS_COLOR[entry.status]}>{label}</Text>
            <Text color={colors.muted}> {hint}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export async function repeatTransfer(ctx: Context, entry: HistoryEntry): Promise<Outcome> {
  const host = (await listHosts()).find((candidate) => candidate.id === entry.hostId);
  if (!host) throw new AppError(`${entry.hostName} is no longer saved`);
  return transferFlow(ctx, {
    direction: entry.direction,
    host,
    sources: entry.sources,
    destination: entry.destination,
    policy: entry.status === 'done' ? undefined : 'resume',
  });
}

export async function historyCommand(ctx: Context): Promise<Outcome | undefined> {
  const { ui, args } = ctx;
  if (args.clear) {
    const confirmed =
      args.yes ||
      (await ui.confirm('Forget all recorded transfers?', { initial: false, danger: true }));
    if (!confirmed) return warn('History kept', 0);
    await clearHistory();
    return done('History cleared');
  }

  const entries = await listHistory();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return undefined;
  }
  if (entries.length === 0) {
    ui.note('No transfers yet. Start one with: easyscp send');
    return undefined;
  }
  if (!ui.interactive) {
    ui.print(<HistoryTable entries={entries.slice(0, 50)} />);
    return undefined;
  }

  const choices: Choice<HistoryEntry>[] = entries.map((entry) => ({
    value: entry,
    key: entry.id,
    ...describeEntry(entry),
    color: entry.status === 'done' ? undefined : STATUS_COLOR[entry.status],
    description: entry.error,
  }));
  const picked = await ui.select('Pick a transfer to run again', { choices, limit: 12 });
  return repeatTransfer(ctx, picked);
}
