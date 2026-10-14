import { Box, Text } from 'ink';
import type { Context } from '../app/context.js';
import { conflictQuestion, summarizeResult } from '../app/transferText.js';
import { AppError, describeError, type ErrorReport, wentBack } from '../core/errors.js';
import type { Host } from '../core/hosts.js';
import { rememberRemoteDir } from '../core/state.js';
import { localFs } from '../fs/local.js';
import { displayPath, parentDir, resolveInput } from '../fs/ops.js';
import type { RemoteFileSystem } from '../fs/remote.js';
import type { FileSystem } from '../fs/types.js';
import { neededBytes, type RelayOutcome, type RelayProgress, runRelay } from '../relay/run.js';
import { createStage, passThrough, type Stage } from '../relay/stage.js';
import { type HistoryTarget, recordTransfer } from '../transfer/history.js';
import { planTransfer, type SkippedItem, type TransferPlan } from '../transfer/plan.js';
import type { ConflictPolicy, TransferStatus } from '../transfer/run.js';
import { RelayView } from '../ui/components/RelayView.js';
import { pickDirectory } from '../ui/picker/pickers.js';
import { colors, symbols } from '../ui/theme.js';
import type { Ui } from '../ui/ui.js';
import { formatBytes, formatDuration, joinNames, plural, printable } from '../util/format.js';
import type { CopyDestination } from './copyArgs.js';
import { done, fail, type Outcome, warn } from './outcome.js';
import { remoteStart, SkippedList } from './places.js';

interface Pending {
  host: Host;
  fs: RemoteFileSystem;
  dir: string | undefined;
}

interface Target {
  key: string;
  label: string;
  host: Host;
  fs: RemoteFileSystem;
  dir: string;
}

interface Planned extends Target {
  plan: TransferPlan;
}

interface Failure {
  label: string;
  host: Host;
  dir: string;
  error: ErrorReport;
  announced?: boolean;
}

export interface Connections {
  connected: Map<string, RemoteFileSystem>;
  errors: Map<string, unknown>;
}

interface Words {
  verb: string;
  missed: string;
  action: string;
  noun: string;
}

const WORDS: Record<'copy' | 'send', Words> = {
  copy: { verb: 'Copied', missed: 'Not copied to', action: 'copy here', noun: 'Copy' },
  send: { verb: 'Sent', missed: 'Not sent to', action: 'send here', noun: 'Transfer' },
};

export type DeliverSpec = {
  paths: string[];
  destinations: CopyDestination[];
  connections: Connections;
  policy?: ConflictPolicy;
} & ({ mode: 'copy'; source: Host; sourceFs: RemoteFileSystem } | { mode: 'send' });

export function uniqueHosts(destinations: CopyDestination[]): Host[] {
  const hosts = new Map<string, Host>();
  for (const { host } of destinations) hosts.set(host.id, host);
  return [...hosts.values()];
}

export async function connectHosts(ctx: Context, hosts: Host[]): Promise<Connections> {
  const connected = new Map<string, RemoteFileSystem>();
  const errors = new Map<string, unknown>();
  if (hosts.length === 0) return { connected, errors };
  const settled = await ctx.connectAll(hosts);
  settled.forEach((result, index) => {
    const host = hosts[index] as Host;
    if (result.status === 'fulfilled') connected.set(host.id, result.value);
    else if (wentBack(result.reason)) throw result.reason;
    else errors.set(host.id, result.reason);
  });
  return { connected, errors };
}

function rebase(dir: string, from: FileSystem, to: FileSystem): string {
  const relative = from.path.relative(from.home, dir);
  if (relative.startsWith('..') || from.path.isAbsolute(relative)) return dir;
  return to.path.join(to.home, ...relative.split(from.path.sep).filter(Boolean));
}

async function chooseFolders(ui: Ui, pending: Pending[], action: string): Promise<void> {
  const missing = pending.filter((entry) => entry.dir === undefined);
  const [first, ...rest] = missing;
  if (!first) return;
  if (!ui.interactive) {
    throw new AppError(
      `Choose where to put the files on ${joinNames(missing.map((entry) => entry.host.name))}`,
      'Add a folder to each machine, like web2:/srv/app, or pass --to <folder>.',
    );
  }
  const pick = async (entry: Pending) => {
    const { start, shortcuts } = await remoteStart(entry.fs, entry.host);
    return pickDirectory(ui, {
      fs: entry.fs,
      start,
      shortcuts,
      title: `Where on ${entry.host.name}?`,
      action,
    });
  };
  first.dir = await pick(first);
  if (rest.length === 0) return;
  const shown = displayPath(first.fs, first.dir);
  const same = await ui.select(`Use ${shown} on ${joinNames(rest.map((e) => e.host.name))} too?`, {
    filter: false,
    choices: [
      { value: true, label: 'Yes, the same folder everywhere', hint: shown },
      { value: false, label: 'Choose a folder on each machine' },
    ],
  });
  for (const entry of rest) {
    entry.dir = same ? rebase(first.dir, first.fs, entry.fs) : await pick(entry);
  }
}

function machineKey(host: Host): string {
  return `${host.jump ?? ''}>${host.hostname.toLowerCase()}:${host.port}`;
}

function labelTargets(ui: Ui, entries: Pending[]): Target[] {
  const unique = new Map<string, Pending & { dir: string }>();
  for (const entry of entries) {
    const dir = entry.dir as string;
    const key = `${machineKey(entry.host)}:${dir}`;
    const kept = unique.get(key);
    if (!kept) {
      unique.set(key, { ...entry, dir });
    } else if (kept.host.id !== entry.host.id) {
      ui.note(
        `${entry.host.name} and ${kept.host.name} are the same machine, so ${displayPath(entry.fs, dir)} only gets one copy`,
        'warning',
      );
    }
  }
  const list = [...unique.values()];
  return list.map((entry) => {
    const shared = list.filter((other) => other.host.id === entry.host.id).length > 1;
    return {
      ...entry,
      key: `${entry.host.id}:${entry.dir}`,
      label: shared ? `${entry.host.name}:${displayPath(entry.fs, entry.dir)}` : entry.host.name,
    };
  });
}

function mergeSkipped(plans: TransferPlan[]): SkippedItem[] {
  const seen = new Map<string, SkippedItem>();
  for (const plan of plans) {
    for (const item of plan.skipped) if (!seen.has(item.path)) seen.set(item.path, item);
  }
  return [...seen.values()];
}

async function askPolicy(ctx: Context, planned: Planned[]): Promise<ConflictPolicy | undefined> {
  const { ui, args } = ctx;
  const clashing = planned.filter((entry) => entry.plan.conflicts.length > 0);
  if (clashing.length === 0) return undefined;
  if (args.yes) return 'overwrite';
  const [first] = planned as [Planned];
  const combined: TransferPlan = {
    ...first.plan,
    files: planned.flatMap((entry) => entry.plan.files),
    conflicts: planned.flatMap((entry) => entry.plan.conflicts),
  };
  const where = `on ${joinNames(clashing.map((entry) => entry.label))}`;
  if (!ui.interactive) {
    const count = combined.conflicts.length;
    throw new AppError(
      `${plural(count, 'file')} already ${count === 1 ? 'exists' : 'exist'} ${where}`,
      'Choose what to do with --overwrite, --skip, --newer, --rename or --resume.',
    );
  }
  const question = conflictQuestion(combined, where);
  return ui.select(question.title, {
    choices: question.choices,
    initial: question.initial,
    filter: false,
  });
}

async function relayWithProgress(
  ctx: Context,
  stage: Stage,
  spec: DeliverSpec,
  planned: Planned[],
  policy: ConflictPolicy,
): Promise<RelayOutcome[]> {
  const { ui } = ctx;
  const controller = new AbortController();
  const names = joinNames(planned.map((entry) => entry.label));
  const title =
    spec.mode === 'copy' ? `Copying from ${spec.source.name} to ${names}` : `Sending to ${names}`;
  const sourceName = spec.mode === 'copy' ? spec.source.name : undefined;
  let progress: RelayProgress | undefined;
  let cancelling = false;
  const view = () => (
    <RelayView title={title} source={sourceName} progress={progress} cancelling={cancelling} />
  );
  const task = ui.task(view());
  const stop = ui.onInterrupt(() => {
    if (cancelling) return;
    cancelling = true;
    controller.abort();
    task.update(view());
  });
  try {
    return await runRelay(
      stage,
      planned.map((entry) => ({
        key: entry.key,
        label: entry.label,
        plan: entry.plan,
        reconnect: () => ctx.connect(entry.host),
      })),
      {
        policy,
        signal: controller.signal,
        reconnectSource: spec.mode === 'copy' ? () => ctx.connect(spec.source) : undefined,
        onProgress: (update) => {
          progress = update;
          task.update(view());
        },
      },
    );
  } finally {
    stop();
    task.close();
  }
}

function overallStatus(statuses: TransferStatus[]): TransferStatus {
  if (statuses.includes('cancelled')) return 'cancelled';
  if (statuses.every((status) => status === 'done')) return 'done';
  if (statuses.some((status) => status === 'done' || status === 'partial')) return 'partial';
  return 'failed';
}

function report(
  ui: Ui,
  words: Words,
  outcomes: RelayOutcome[],
  failures: Failure[],
  detail: string,
): Outcome {
  const succeeded = outcomes.filter((outcome) => outcome.result.status === 'done');
  const problems: { label: string; message: string; hint?: string }[] = [
    ...failures.map((failure) => ({
      label: failure.label,
      message: failure.error.message,
      hint: failure.announced ? undefined : failure.error.hint,
    })),
    ...outcomes
      .filter((outcome) => outcome.result.status !== 'done')
      .map((outcome) => {
        const summary = summarizeResult(outcome.result, words.verb, `to ${outcome.label}`);
        return { label: outcome.label, message: summary.message, hint: summary.detail };
      }),
  ];
  const cancelled = outcomes.some((outcome) => outcome.result.status === 'cancelled');
  const hints = new Set(problems.map((problem) => problem.hint));
  const sharedHint = problems.length > 1 && hints.size === 1 ? problems[0]?.hint : undefined;
  const counts = new Set(succeeded.map((outcome) => outcome.result.files));
  const files = [...counts][0] ?? 0;

  if (problems.length === 0) {
    if (counts.size === 1 && files === 0) return done('Everything is already up to date');
    const what = counts.size === 1 ? plural(files, 'file') : 'files';
    return done(`${words.verb} ${what} to ${joinNames(succeeded.map((o) => o.label))}`, detail);
  }

  if (succeeded.length > 0) {
    ui.step(
      <Text color={colors.success}>
        {words.verb} to {joinNames(succeeded.map((outcome) => outcome.label))}
      </Text>,
      <Text color={colors.muted}>{detail}</Text>,
      'success',
    );
  }
  ui.step(
    <Text color={cancelled ? colors.warning : colors.danger}>
      {cancelled ? 'Cancelled' : `${words.missed} ${joinNames(problems.map((p) => p.label))}`}
    </Text>,
    <Box flexDirection="column">
      {problems.map((problem) => (
        <Box key={problem.label} flexDirection="column">
          <Text wrap="truncate-end">
            <Text bold>{problem.label}</Text>: {printable(problem.message)}
          </Text>
          {problem.hint && !sharedHint ? (
            <Text color={colors.muted} wrap="truncate-end">
              {'  '}
              {printable(problem.hint)}
            </Text>
          ) : null}
        </Box>
      ))}
      {sharedHint ? <Text color={colors.muted}>{printable(sharedHint)}</Text> : null}
    </Box>,
    cancelled ? 'warning' : 'danger',
  );
  if (cancelled) return warn(`${words.noun} cancelled`, 130);
  if (succeeded.length > 0) {
    return warn(
      `${words.verb} to ${succeeded.length} of ${succeeded.length + problems.length} machines`,
    );
  }
  return fail(`${words.noun} failed`);
}

export async function deliver(ctx: Context, spec: DeliverSpec): Promise<Outcome> {
  const { ui, args } = ctx;
  const words = WORDS[spec.mode];
  const sourceFs = spec.mode === 'copy' ? spec.sourceFs : localFs;
  const { connected, errors } = spec.connections;

  const failures: Failure[] = [];
  const reachable: Pending[] = [];
  for (const entry of spec.destinations) {
    const fs = connected.get(entry.host.id);
    if (fs) {
      reachable.push({
        host: entry.host,
        fs,
        dir: entry.dir === undefined ? undefined : resolveInput(fs, entry.dir, fs.home),
      });
    } else if (
      !failures.some(
        (failure) => failure.host.id === entry.host.id && failure.dir === (entry.dir ?? ''),
      )
    ) {
      failures.push({
        label: entry.host.name,
        host: entry.host,
        dir: entry.dir ?? '',
        error: describeError(errors.get(entry.host.id)),
      });
    }
  }
  if (reachable.length === 0) {
    const [only] = failures;
    throw new AppError(
      failures.length === 1 && only
        ? `Could not connect to ${only.label}: ${only.error.message}`
        : `Could not connect to ${joinNames(failures.map((failure) => failure.label))}`,
      only?.error.hint,
    );
  }
  for (const failure of failures) {
    failure.announced = true;
    ui.step(
      <Text color={colors.warning}>
        Skipping {failure.label}: {failure.error.message}
      </Text>,
      failure.error.hint ? <Text color={colors.muted}>{failure.error.hint}</Text> : undefined,
      'warning',
    );
  }

  await chooseFolders(ui, reachable, words.action);
  const targets = labelTargets(ui, reachable);

  const started = performance.now();
  const stage = spec.mode === 'copy' ? await createStage(spec.sourceFs) : passThrough(localFs);
  try {
    const checking = `Checking ${joinNames(targets.map((target) => target.label))}`;
    const settled = await ui.spin(checking, (setLabel) => {
      let scanned = 0;
      const onScan = (count: number) => {
        if (count <= scanned) return;
        scanned = count;
        setLabel(`${checking} ${symbols.dot} ${plural(count, 'item')} found`);
      };
      return Promise.allSettled(
        targets.map((target) =>
          planTransfer(
            {
              source: stage,
              target: target.fs,
              sources: spec.paths,
              destination: target.dir,
              placement: 'into',
            },
            { signal: ui.signal, onScan },
          ),
        ),
      );
    });
    ui.signal.throwIfAborted();
    const planned: Planned[] = [];
    settled.forEach((result, index) => {
      const target = targets[index] as Target;
      if (result.status === 'fulfilled') planned.push({ ...target, plan: result.value });
      else failures.push({ ...target, error: describeError(result.reason) });
    });
    if (planned.length === 0) {
      const [only] = failures;
      throw new AppError(only?.error.message ?? 'Nothing to copy', only?.error.hint);
    }

    const skipped = mergeSkipped(planned.map((entry) => entry.plan));
    if (skipped.length > 0) {
      ui.step(
        <Text color={colors.warning}>{plural(skipped.length, 'item')} will be skipped</Text>,
        <SkippedList fs={sourceFs} items={skipped} />,
        'warning',
      );
    }
    if (planned.every((entry) => entry.plan.files.length === 0 && entry.plan.dirs.length === 0)) {
      throw new AppError(
        `There is nothing to ${spec.mode === 'copy' ? 'copy' : 'transfer'}`,
        'The selection only contains skipped items.',
      );
    }

    const policy = spec.policy ?? args.policy ?? (await askPolicy(ctx, planned)) ?? 'skip';
    if (spec.mode === 'copy') {
      const needed = neededBytes(planned, policy);
      if (planned.length > 1 && needed > stage.budget) {
        ui.note(
          `Only ${formatBytes(stage.budget)} of the ${formatBytes(needed)} can be cached here, so some of it will be downloaded once per machine.`,
          'warning',
        );
      }
    }

    const outcomes = await relayWithProgress(ctx, stage, spec, planned, policy);
    const durationMs = performance.now() - started;
    const fetched = stage.stats.fetched;
    const sent = Math.max(0, ...outcomes.map((outcome) => outcome.result.bytes));
    const delivered = outcomes.filter((outcome) => outcome.result.status === 'done').length;
    const bytes = spec.mode === 'copy' ? fetched : sent;

    const statuses: TransferStatus[] = [
      ...outcomes.map((outcome) => outcome.result.status),
      ...failures.map((): TransferStatus => 'failed'),
    ];
    const plannedFor = (outcome: RelayOutcome) =>
      planned.find((entry) => entry.key === outcome.key) as Planned;
    const historyTargets: HistoryTarget[] = [
      ...outcomes.map((outcome) => {
        const target = plannedFor(outcome);
        return {
          hostId: target.host.id,
          hostName: target.host.name,
          destination: target.dir,
          status: outcome.result.status,
        };
      }),
      ...failures.map((failure) => ({
        hostId: failure.host.id,
        hostName: failure.host.name,
        destination: failure.dir,
        status: 'failed' as const,
      })),
    ];
    const copiedFiles = Math.max(0, ...outcomes.map((outcome) => outcome.result.files));
    const changed = copiedFiles > 0 || statuses.some((status) => status !== 'done');
    const [firstTarget] = historyTargets as [HistoryTarget];
    const origin =
      spec.mode === 'copy'
        ? {
            direction: 'copy' as const,
            hostId: spec.source.id,
            hostName: spec.source.name,
            destination: '',
          }
        : {
            direction: 'upload' as const,
            hostId: firstTarget.hostId,
            hostName: firstTarget.hostName,
            destination: firstTarget.destination,
          };
    const sourceDir =
      spec.mode === 'copy' ? parentDir(spec.sourceFs, spec.paths[0] as string) : undefined;
    await Promise.all([
      changed
        ? recordTransfer({
            ...origin,
            sources: spec.paths,
            files: copiedFiles,
            bytes,
            durationMs: Math.round(durationMs),
            status: overallStatus(statuses),
            targets: historyTargets,
          })
        : undefined,
      spec.mode === 'copy' && sourceDir ? rememberRemoteDir(spec.source.id, sourceDir) : undefined,
      ...outcomes
        .filter((outcome) => outcome.result.files > 0)
        .map((outcome) => {
          const target = plannedFor(outcome);
          return rememberRemoteDir(target.host.id, target.plan.anchor);
        }),
    ]).catch(() => undefined);

    const detail = [
      bytes > 0 &&
        (spec.mode === 'copy'
          ? `${formatBytes(bytes)} from ${spec.source.name}`
          : `${formatBytes(bytes)}${delivered > 1 ? ' to each' : ''}`),
      `in ${formatDuration(durationMs)}`,
    ]
      .filter(Boolean)
      .join(` ${symbols.dot} `);
    return report(ui, words, outcomes, failures, detail);
  } finally {
    await stage.close();
  }
}
