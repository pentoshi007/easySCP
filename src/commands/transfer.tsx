import os from 'node:os';
import path from 'node:path';
import { Box, Text } from 'ink';
import type { Context } from '../app/context.js';
import { chooseHost } from '../app/hostPicker.js';
import { conflictQuestion, summarizeResult } from '../app/transferText.js';
import { AppError } from '../core/errors.js';
import { findHost, type Host, requireHost } from '../core/hosts.js';
import {
  recentLocalDirs,
  recentRemoteDirs,
  rememberLocalDir,
  rememberRemoteDir,
} from '../core/state.js';
import { expandPaths } from '../fs/glob.js';
import { localFs } from '../fs/local.js';
import { displayPath, parentDir, resolveInput } from '../fs/ops.js';
import type { RemoteFileSystem } from '../fs/remote.js';
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
import type { Shortcut } from '../ui/picker/model.js';
import { pickDirectory, pickFiles } from '../ui/picker/pickers.js';
import { colors, symbols } from '../ui/theme.js';
import type { Ui } from '../ui/ui.js';
import { plural } from '../util/format.js';
import { addHost } from './add.js';
import { done, fail, type Outcome, warn } from './outcome.js';

export async function transferCommand(ctx: Context, direction: Direction): Promise<Outcome> {
  const [first, ...rest] = ctx.args.positionals;
  let hostName: string | undefined;
  let sources: string[] = [];
  if (first !== undefined) {
    if (await findHost(first)) {
      hostName = first;
      sources = rest;
    } else if (
      direction === 'upload' &&
      (await localFs.stat(resolveInput(localFs, first, process.cwd())))
    ) {
      sources = [first, ...rest];
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
  sources?: string[];
  destination?: string;
  policy?: ConflictPolicy;
}

const MAX_SHORTCUTS = 5;
const MAX_LISTED_FAILURES = 5;

async function existingDirs(fs: FileSystem, candidates: (string | undefined)[]): Promise<string[]> {
  const unique = [...new Set(candidates.filter((dir): dir is string => Boolean(dir)))];
  const checks = await Promise.all(
    unique.map(async (dir) => ((await fs.stat(dir))?.kind === 'dir' ? dir : undefined)),
  );
  return checks.filter((dir): dir is string => dir !== undefined);
}

export async function remoteStart(
  fs: RemoteFileSystem,
  host: Host,
): Promise<{ start: string; shortcuts: Shortcut[] }> {
  const configured = host.remoteDir ? resolveInput(fs, host.remoteDir, fs.home) : undefined;
  const recent = await recentRemoteDirs(host.id);
  const dirs = await existingDirs(fs, [configured, ...recent, fs.home]);
  const start = dirs[0] ?? fs.home;
  const shortcuts: Shortcut[] = [];
  if (configured && dirs.includes(configured))
    shortcuts.push({ path: configured, label: 'Default folder' });
  for (const dir of recent) {
    if (shortcuts.length >= MAX_SHORTCUTS) break;
    if (dirs.includes(dir) && !shortcuts.some((entry) => entry.path === dir)) {
      shortcuts.push({ path: dir, label: 'Recent' });
    }
  }
  if (!shortcuts.some((entry) => entry.path === fs.home))
    shortcuts.push({ path: fs.home, label: 'Home' });
  return { start, shortcuts };
}

async function localStart(host: Host): Promise<{ start: string; shortcuts: Shortcut[] }> {
  const home = os.homedir();
  const named: Shortcut[] = [
    { path: process.cwd(), label: 'Current folder' },
    { path: path.join(home, 'Downloads'), label: 'Downloads' },
    { path: path.join(home, 'Desktop'), label: 'Desktop' },
    { path: home, label: 'Home' },
  ];
  const recent = (await recentLocalDirs()).map((dir) => ({ path: dir, label: 'Recent' }));
  const configured = host.localDir ? [{ path: host.localDir, label: 'Default folder' }] : [];
  const candidates = [...configured, ...recent.slice(0, 3), ...named];
  const valid = new Set(
    await existingDirs(
      localFs,
      candidates.map((entry) => entry.path),
    ),
  );
  const shortcuts: Shortcut[] = [];
  for (const entry of candidates) {
    if (valid.has(entry.path) && !shortcuts.some((existing) => existing.path === entry.path)) {
      shortcuts.push(entry);
    }
  }
  const start = host.localDir && valid.has(host.localDir) ? host.localDir : process.cwd();
  return { start, shortcuts: shortcuts.slice(0, MAX_SHORTCUTS + 1) };
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

function SkippedList({ plan }: { plan: TransferPlan }) {
  const shown = plan.skipped.slice(0, MAX_LISTED_FAILURES);
  return (
    <Box flexDirection="column">
      {shown.map((item) => (
        <Text key={item.path} color={colors.muted} wrap="truncate-middle">
          {symbols.dot} {displayPath(plan.spec.source, item.path)}{' '}
          <Text dimColor>{item.reason}</Text>
        </Text>
      ))}
      {plan.skipped.length > shown.length ? (
        <Text color={colors.muted}>
          {symbols.ellipsis} and {plan.skipped.length - shown.length} more
        </Text>
      ) : null}
    </Box>
  );
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
              <Text color={colors.danger}>{symbols.error}</Text> {failure.path}{' '}
              <Text color={colors.muted}>{failure.message}</Text>
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

export async function transferFlow(ctx: Context, request: TransferRequest): Promise<Outcome> {
  const { ui, args } = ctx;
  const upload = request.direction === 'upload';
  const host =
    request.host ??
    (await chooseHost(ctx, {
      title: upload ? 'Send to which machine?' : 'Receive from which machine?',
      name: request.hostName,
      onAdd: () => addHost(ctx),
    }));

  let localSources: string[] | undefined;
  if (upload) {
    localSources = request.sources?.length
      ? await expandPaths(localFs, request.sources, process.cwd())
      : await pickFiles(ui, {
          fs: localFs,
          start: host.localDir ?? process.cwd(),
          title: `What do you want to send to ${host.name}?`,
          action: 'send',
        });
  }

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
    if (request.destination) {
      destination = resolveInput(remote, request.destination, remote.home);
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
    if (request.destination) {
      destination = resolveInput(localFs, request.destination, process.cwd());
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
    intoDirectory: picked,
  });

  if (plan.skipped.length > 0) {
    ui.step(
      <Text color={colors.warning}>{plural(plan.skipped.length, 'item')} will be skipped</Text>,
      <SkippedList plan={plan} />,
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
