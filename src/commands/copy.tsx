import { Box, Text } from 'ink';
import type { Context } from '../app/context.js';
import { chooseHost, hostChoice } from '../app/hostPicker.js';
import { conflictQuestion, summarizeResult } from '../app/transferText.js';
import { AppError, describeError, type ErrorReport, wentBack } from '../core/errors.js';
import { type Host, listHosts } from '../core/hosts.js';
import { rememberRemoteDir } from '../core/state.js';
import { expandPaths } from '../fs/glob.js';
import { displayPath, parentDir, resolveInput } from '../fs/ops.js';
import type { RemoteFileSystem } from '../fs/remote.js';
import type { FileSystem } from '../fs/types.js';
import { neededBytes, type RelayOutcome, type RelayProgress, runRelay } from '../relay/run.js';
import { createStage, type Stage } from '../relay/stage.js';
import { type HistoryTarget, recordTransfer } from '../transfer/history.js';
import { planTransfer, type SkippedItem, type TransferPlan } from '../transfer/plan.js';
import type { ConflictPolicy, TransferStatus } from '../transfer/run.js';
import { RelayView } from '../ui/components/RelayView.js';
import { pickDirectory, pickFiles } from '../ui/picker/pickers.js';
import { colors, symbols } from '../ui/theme.js';
import type { Ui } from '../ui/ui.js';
import { formatBytes, formatDuration, joinNames, plural, printable } from '../util/format.js';
import { type CopyDestination, parseCopyTokens } from './copyArgs.js';
import { done, fail, type Outcome, warn } from './outcome.js';
import { remoteStart, SkippedList } from './transfer.js';

export interface CopyFlowRequest {
  source?: Host;
  paths?: string[];
  destinations?: CopyDestination[];
  policy?: ConflictPolicy;
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

export async function copyCommand(ctx: Context): Promise<Outcome> {
  const request = parseCopyTokens(ctx.args.positionals, await listHosts());
  return copyFlow(ctx, {
    source: request.source,
    paths: request.paths,
    destinations: request.destinations.map((entry) => ({
      host: entry.host,
      dir: entry.dir ?? ctx.args.to,
    })),
  });
}

function rebase(dir: string, from: FileSystem, to: FileSystem): string {
  const relative = from.path.relative(from.home, dir);
  if (relative.startsWith('..') || from.path.isAbsolute(relative)) return dir;
  return to.path.join(to.home, ...relative.split(from.path.sep).filter(Boolean));
}

function uniqueHosts(destinations: CopyDestination[]): Host[] {
  const hosts = new Map<string, Host>();
  for (const { host } of destinations) hosts.set(host.id, host);
  return [...hosts.values()];
}

async function connectHosts(ctx: Context, hosts: Host[]) {
  const settled = await ctx.connectAll(hosts);
  const connected = new Map<string, RemoteFileSystem>();
  const errors = new Map<string, unknown>();
  settled.forEach((result, index) => {
    const host = hosts[index] as Host;
    if (result.status === 'fulfilled') connected.set(host.id, result.value);
    else if (wentBack(result.reason)) throw result.reason;
    else errors.set(host.id, result.reason);
  });
  return { connected, errors };
}

async function chooseFolders(
  ui: Ui,
  pending: { host: Host; fs: RemoteFileSystem; dir: string | undefined }[],
): Promise<void> {
  const missing = pending.filter((entry) => entry.dir === undefined);
  const [first, ...rest] = missing;
  if (!first) return;
  if (!ui.interactive) {
    throw new AppError(
      `Choose where to put the files on ${joinNames(missing.map((entry) => entry.host.name))}`,
      'Add a folder to each machine, like web2:/srv/app, or pass --to <folder>.',
    );
  }
  const pick = async (entry: (typeof missing)[number]) => {
    const { start, shortcuts } = await remoteStart(entry.fs, entry.host);
    return pickDirectory(ui, {
      fs: entry.fs,
      start,
      shortcuts,
      title: `Where on ${entry.host.name}?`,
      action: 'copy here',
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

function labelTargets(entries: { host: Host; fs: RemoteFileSystem; dir: string }[]): Target[] {
  return entries.map((entry) => {
    const shared = entries.filter((other) => other.host.id === entry.host.id).length > 1;
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
  source: Host,
  planned: Planned[],
  policy: ConflictPolicy,
): Promise<RelayOutcome[]> {
  const { ui } = ctx;
  const controller = new AbortController();
  const title = `Copying from ${source.name} to ${joinNames(planned.map((entry) => entry.label))}`;
  let progress: RelayProgress | undefined;
  let cancelling = false;
  const view = () => (
    <RelayView title={title} source={source.name} progress={progress} cancelling={cancelling} />
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
        reconnectSource: () => ctx.connect(source),
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
  source: Host,
  outcomes: RelayOutcome[],
  failures: Failure[],
  fetched: number,
  durationMs: number,
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
        const summary = summarizeResult(outcome.result, 'Copied', `to ${outcome.label}`);
        return { label: outcome.label, message: summary.message, hint: summary.detail };
      }),
  ];
  const cancelled = outcomes.some((outcome) => outcome.result.status === 'cancelled');
  const hints = new Set(problems.map((problem) => problem.hint));
  const sharedHint = problems.length > 1 && hints.size === 1 ? problems[0]?.hint : undefined;
  const counts = new Set(succeeded.map((outcome) => outcome.result.files));
  const files = [...counts][0] ?? 0;
  const detail = [
    fetched > 0 && `${formatBytes(fetched)} from ${source.name}`,
    `in ${formatDuration(durationMs)}`,
  ]
    .filter(Boolean)
    .join(` ${symbols.dot} `);

  if (problems.length === 0) {
    if (counts.size === 1 && files === 0) return done('Everything is already up to date');
    const what = counts.size === 1 ? plural(files, 'file') : 'files';
    return done(`Copied ${what} to ${joinNames(succeeded.map((o) => o.label))}`, detail);
  }

  if (succeeded.length > 0) {
    ui.step(
      <Text color={colors.success}>
        Copied to {joinNames(succeeded.map((outcome) => outcome.label))}
      </Text>,
      <Text color={colors.muted}>{detail}</Text>,
      'success',
    );
  }
  ui.step(
    <Text color={cancelled ? colors.warning : colors.danger}>
      {cancelled ? 'Cancelled' : `Not copied to ${joinNames(problems.map((p) => p.label))}`}
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
  if (cancelled) return warn('Copy cancelled', 130);
  if (succeeded.length > 0) {
    return warn(`Copied to ${succeeded.length} of ${succeeded.length + problems.length} machines`);
  }
  return fail('Copy failed');
}

export async function copyFlow(ctx: Context, request: CopyFlowRequest): Promise<Outcome> {
  const { ui, args } = ctx;
  const hosts = await listHosts();
  if (hosts.length < 2) {
    throw new AppError(
      'Copying between machines needs at least two saved machines',
      'Save another one with `easyscp add`.',
    );
  }
  const source = request.source ?? (await chooseHost(ctx, { title: 'Copy from which machine?' }));
  const known = request.destinations ?? [];
  for (const entry of known) {
    if (entry.host.id === source.id) {
      throw new AppError(
        `${source.name} is the machine you are copying from`,
        'Choose other machines as destinations.',
      );
    }
  }

  let { connected, errors } = await connectHosts(ctx, [source, ...uniqueHosts(known)]);
  if (errors.has(source.id)) throw errors.get(source.id);
  const sourceFs = connected.get(source.id) as RemoteFileSystem;

  const paths = request.paths?.length
    ? await expandPaths(sourceFs, request.paths, sourceFs.home)
    : await pickFiles(ui, {
        fs: sourceFs,
        start: (await remoteStart(sourceFs, source)).start,
        title: `What do you want to copy from ${source.name}?`,
        action: 'copy',
      });

  let destinations = known;
  if (destinations.length === 0) {
    const others = hosts.filter((host) => host.id !== source.id);
    const picked = await ui.multiselect('Copy to which machines?', {
      choices: others.map(hostChoice),
      selected: others.length === 1 ? others : [],
      required: true,
    });
    destinations = picked.map((host) => ({ host, dir: args.to }));
    ({ connected, errors } = await connectHosts(ctx, picked));
  }

  const failures: Failure[] = [];
  const reachable: { host: Host; fs: RemoteFileSystem; dir: string | undefined }[] = [];
  for (const entry of destinations) {
    const fs = connected.get(entry.host.id);
    if (fs) {
      reachable.push({
        host: entry.host,
        fs,
        dir: entry.dir === undefined ? undefined : resolveInput(fs, entry.dir, fs.home),
      });
    } else {
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

  await chooseFolders(ui, reachable);
  const targets = labelTargets(reachable.map((entry) => ({ ...entry, dir: entry.dir as string })));

  const started = performance.now();
  const stage = await createStage(sourceFs);
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
              sources: paths,
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
      throw new AppError('There is nothing to copy', 'The selection only contains skipped items.');
    }

    const policy = request.policy ?? args.policy ?? (await askPolicy(ctx, planned)) ?? 'skip';
    const needed = neededBytes(planned, policy);
    if (planned.length > 1 && needed > stage.budget) {
      ui.note(
        `Only ${formatBytes(stage.budget)} of the ${formatBytes(needed)} can be cached here, so some of it will be downloaded once per machine.`,
        'warning',
      );
    }

    const outcomes = await relayWithProgress(ctx, stage, source, planned, policy);
    const durationMs = performance.now() - started;
    const fetched = stage.stats.fetched;

    const statuses: TransferStatus[] = [
      ...outcomes.map((outcome) => outcome.result.status),
      ...failures.map((): TransferStatus => 'failed'),
    ];
    const historyTargets: HistoryTarget[] = [
      ...outcomes.map((outcome) => {
        const target = planned.find((entry) => entry.key === outcome.key) as Planned;
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
    const sourceDir = parentDir(sourceFs, paths[0] as string);
    await Promise.all([
      changed
        ? recordTransfer({
            direction: 'copy',
            hostId: source.id,
            hostName: source.name,
            sources: paths,
            destination: '',
            files: copiedFiles,
            bytes: fetched,
            durationMs: Math.round(durationMs),
            status: overallStatus(statuses),
            targets: historyTargets,
          })
        : undefined,
      sourceDir ? rememberRemoteDir(source.id, sourceDir) : undefined,
      ...outcomes
        .filter((outcome) => outcome.result.files > 0)
        .map((outcome) => {
          const target = planned.find((entry) => entry.key === outcome.key) as Planned;
          return rememberRemoteDir(target.host.id, target.plan.anchor);
        }),
    ]).catch(() => undefined);

    return report(ui, source, outcomes, failures, fetched, durationMs);
  } finally {
    await stage.close();
  }
}
