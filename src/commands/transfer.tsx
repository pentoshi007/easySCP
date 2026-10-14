import { Box, Text } from 'ink';
import type { Context } from '../app/context.js';
import { chooseHost, chooseHosts } from '../app/hostPicker.js';
import { conflictQuestion, summarizeResult } from '../app/transferText.js';
import { AppError } from '../core/errors.js';
import { findHost, type Host, listHosts, requireHost } from '../core/hosts.js';
import { rememberLocalDir, rememberRemoteDir } from '../core/state.js';
import { expandPaths, hasGlob } from '../fs/glob.js';
import { localFs } from '../fs/local.js';
import { displayPath, parentDir, resolveInput } from '../fs/ops.js';
import type { FileSystem } from '../fs/types.js';
import { type Direction, recordTransfer } from '../transfer/history.js';
import { planTransfer, type TransferPlan } from '../transfer/plan.js';
import {
  type ConflictPolicy,
  runTransfer,
  type TransferProgress,
  type TransferResult,
} from '../transfer/run.js';
import { TransferView } from '../ui/components/TransferView.js';
import { pickDirectory, pickFiles } from '../ui/picker/pickers.js';
import { colors, symbols } from '../ui/theme.js';
import type { Ui } from '../ui/ui.js';
import { joinNames, plural, printable } from '../util/format.js';
import { addHost } from './add.js';
import { type CopyDestination, parseSendTokens } from './copyArgs.js';
import { connectHosts, deliver, uniqueHosts } from './fanout.js';
import { done, fail, type Outcome, warn } from './outcome.js';
import { localStart, MAX_LISTED_FAILURES, remoteStart, SkippedList } from './places.js';

async function isLocalPath(token: string): Promise<boolean> {
  return Boolean(await localFs.stat(resolveInput(localFs, token, process.cwd())));
}

export async function transferCommand(ctx: Context, direction: Direction): Promise<Outcome> {
  if (direction === 'upload') {
    const request = await parseSendTokens(ctx.args.positionals, await listHosts(), isLocalPath);
    if (request.destinations.length === 0) {
      for (const token of request.paths) {
        if (!hasGlob(token) && !(await isLocalPath(token))) await requireHost(token);
      }
    }
    return transferFlow(ctx, {
      direction,
      sources: request.paths,
      destinations: request.destinations.map((entry) => ({
        host: entry.host,
        dir: entry.dir ?? ctx.args.to,
      })),
      destination: ctx.args.to,
    });
  }

  const [first, ...rest] = ctx.args.positionals;
  let hostName: string | undefined;
  let sources: string[] = [];
  if (first !== undefined) {
    if (await findHost(first)) {
      hostName = first;
      sources = rest;
    } else {
      await requireHost(first);
    }
  }
  return transferFlow(ctx, {
    direction,
    hostName,
    sources,
    destination: ctx.args.to,
  });
}

export interface TransferRequest {
  direction: Direction;
  host?: Host;
  hostName?: string;
  destinations?: CopyDestination[];
  sources?: string[];
  destination?: string;
  policy?: ConflictPolicy;
}

async function planWithProgress(ui: Ui, title: string, spec: Parameters<typeof planTransfer>[0]) {
  let scanned = 0;
  const view = () => <TransferView title={title} progress={undefined} scanned={scanned} />;
  const task = ui.task(view());
  try {
    return await planTransfer(spec, {
      signal: ui.signal,
      onScan: (count) => {
        scanned = count;
        task.update(view());
      },
    });
  } finally {
    task.close();
  }
}

async function askPolicy(ctx: Context, plan: TransferPlan, where: string): Promise<ConflictPolicy> {
  const question = conflictQuestion(plan, where);
  return ctx.ui.select(question.title, {
    choices: question.choices,
    initial: question.initial,
    filter: false,
  });
}

async function runWithProgress(
  ui: Ui,
  plan: TransferPlan,
  policy: ConflictPolicy,
  title: string,
): Promise<TransferResult> {
  const controller = new AbortController();
  let progress: TransferProgress | undefined;
  let cancelling = false;
  const view = () => <TransferView title={title} progress={progress} cancelling={cancelling} />;
  const task = ui.task(view());
  const stop = ui.onInterrupt(() => {
    if (cancelling) return;
    cancelling = true;
    controller.abort();
    task.update(view());
  });
  try {
    return await runTransfer(plan, {
      policy,
      signal: controller.signal,
      onProgress: (update) => {
        progress = update;
        task.update(view());
      },
    });
  } finally {
    stop();
    task.close();
  }
}

function report(ui: Ui, result: TransferResult, verb: string, where: string): Outcome {
  const summary = summarizeResult(result, verb, where);
  switch (result.status) {
    case 'done':
      return done(summary.message, summary.detail);
    case 'cancelled':
      ui.step(
        <Text color={colors.warning}>{summary.message}</Text>,
        summary.detail ? <Text color={colors.muted}>{summary.detail}</Text> : undefined,
        'warning',
      );
      return warn('Transfer cancelled', 130);
    default: {
      const shown = result.failed.slice(0, MAX_LISTED_FAILURES);
      ui.step(
        <Text color={colors.danger}>{summary.message}</Text>,
        <Box flexDirection="column">
          {result.error?.hint ? <Text color={colors.muted}>{result.error.hint}</Text> : null}
          {shown.map((failure) => (
            <Text key={failure.path} wrap="truncate-middle">
              <Text color={colors.danger}>{symbols.error}</Text> {printable(failure.path)}{' '}
              <Text color={colors.muted}>{printable(failure.message)}</Text>
            </Text>
          ))}
          {result.failed.length > shown.length ? (
            <Text color={colors.muted}>
              {symbols.ellipsis} and {result.failed.length - shown.length} more
            </Text>
          ) : null}
        </Box>,
        'danger',
      );
      return result.status === 'partial'
        ? warn('Some files were not transferred')
        : fail('Transfer failed');
    }
  }
}

async function sendDestinations(
  ctx: Context,
  request: TransferRequest,
): Promise<CopyDestination[]> {
  if (request.destinations?.length) return request.destinations;
  if (request.host) return [{ host: request.host, dir: request.destination }];
  if (request.hostName) {
    return [{ host: await requireHost(request.hostName), dir: request.destination }];
  }
  const hosts = await chooseHosts(ctx, {
    title: 'Send to which machines?',
    onAdd: () => addHost(ctx),
  });
  return hosts.map((host) => ({ host, dir: request.destination }));
}

async function pickLocalSources(
  ctx: Context,
  request: TransferRequest,
  hosts: Host[],
): Promise<string[]> {
  if (request.sources?.length) return expandPaths(localFs, request.sources, process.cwd());
  const start = hosts.find((host) => host.localDir)?.localDir ?? process.cwd();
  return pickFiles(ctx.ui, {
    fs: localFs,
    start,
    title: `What do you want to send to ${joinNames(hosts.map((host) => host.name))}?`,
    action: 'send',
  });
}

async function sendToMany(
  ctx: Context,
  request: TransferRequest,
  destinations: CopyDestination[],
): Promise<Outcome> {
  const hosts = uniqueHosts(destinations);
  const paths = await pickLocalSources(ctx, request, hosts);
  const connections = await connectHosts(ctx, hosts);
  return deliver(ctx, {
    mode: 'send',
    paths,
    destinations,
    connections,
    policy: request.policy,
  });
}

export async function transferFlow(ctx: Context, request: TransferRequest): Promise<Outcome> {
  const { ui, args } = ctx;
  const upload = request.direction === 'upload';
  let host: Host;
  let typedDestination = request.destination;
  if (upload) {
    const destinations = await sendDestinations(ctx, request);
    if (destinations.length > 1) return sendToMany(ctx, request, destinations);
    const [only] = destinations as [CopyDestination];
    host = only.host;
    typedDestination = only.dir;
  } else {
    host =
      request.host ??
      (await chooseHost(ctx, {
        title: 'Receive from which machine?',
        name: request.hostName,
        onAdd: () => addHost(ctx),
      }));
  }

  const localSources = upload ? await pickLocalSources(ctx, request, [host]) : undefined;

  const remote = await ctx.connect(host);
  let source: FileSystem;
  let target: FileSystem;
  let sources: string[];
  let destination: string;
  let picked = false;

  if (upload) {
    source = localFs;
    target = remote;
    sources = localSources as string[];
    if (typedDestination) {
      destination = resolveInput(remote, typedDestination, remote.home);
    } else {
      const { start, shortcuts } = await remoteStart(remote, host);
      destination = await pickDirectory(ui, {
        fs: remote,
        start,
        shortcuts,
        title: `Where on ${host.name}?`,
        action: 'send here',
      });
      picked = true;
    }
  } else {
    source = remote;
    target = localFs;
    if (request.sources?.length) {
      sources = await expandPaths(remote, request.sources, remote.home);
    } else {
      const { start } = await remoteStart(remote, host);
      sources = await pickFiles(ui, {
        fs: remote,
        start,
        title: `What do you want from ${host.name}?`,
        action: 'download',
      });
    }
    if (typedDestination) {
      destination = resolveInput(localFs, typedDestination, process.cwd());
    } else {
      const { start, shortcuts } = await localStart(host);
      destination = await pickDirectory(ui, {
        fs: localFs,
        start,
        shortcuts,
        title: 'Save to which folder?',
        action: 'save here',
      });
      picked = true;
    }
  }

  const where = upload
    ? `to ${host.name}:${displayPath(remote, destination)}`
    : `to ${displayPath(localFs, destination)}`;
  const title = upload ? `Sending to ${host.name}` : `Downloading from ${host.name}`;
  const plan = await planWithProgress(ui, title, {
    source,
    target,
    sources,
    destination,
    placement: picked ? 'into' : undefined,
  });

  if (plan.skipped.length > 0) {
    ui.step(
      <Text color={colors.warning}>{plural(plan.skipped.length, 'item')} will be skipped</Text>,
      <SkippedList fs={plan.spec.source} items={plan.skipped} />,
      'warning',
    );
  }
  if (plan.files.length === 0 && plan.dirs.length === 0) {
    throw new AppError(
      'There is nothing to transfer',
      'The selection only contains skipped items.',
    );
  }

  let policy = request.policy ?? args.policy;
  if (!policy && plan.conflicts.length > 0) {
    if (args.yes) policy = 'overwrite';
    else if (!ui.interactive) {
      const count = plan.conflicts.length;
      throw new AppError(
        `${plural(count, 'file')} already ${count === 1 ? 'exists' : 'exist'} at the destination`,
        'Choose what to do with --overwrite, --skip, --newer, --rename or --resume.',
      );
    } else {
      policy = await askPolicy(ctx, plan, upload ? `on ${host.name}` : 'here');
    }
  }

  const result = await runWithProgress(ui, plan, policy ?? 'skip', title);
  const outcome = report(ui, result, upload ? 'Sent' : 'Downloaded', where);

  const remoteDir = upload ? plan.anchor : parentDir(remote, sources[0] as string);
  const changed = result.files > 0 || result.status !== 'done';
  await Promise.all([
    changed
      ? recordTransfer({
          direction: request.direction,
          hostId: host.id,
          hostName: host.name,
          sources,
          destination,
          files: result.files,
          bytes: result.bytes,
          durationMs: Math.round(result.durationMs),
          status: result.status,
          ...(result.error ? { error: result.error.message } : {}),
        })
      : undefined,
    result.files > 0 && remoteDir ? rememberRemoteDir(host.id, remoteDir) : undefined,
    result.files > 0 && !upload ? rememberLocalDir(plan.anchor) : undefined,
  ]).catch(() => undefined);

  return outcome;
}
