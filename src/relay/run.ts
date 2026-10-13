import { AppError, describeError } from '../core/errors.js';
import type { FileSystem } from '../fs/types.js';
import { SpeedMeter } from '../transfer/meter.js';
import { type PlannedFile, planTransfer, type TransferPlan } from '../transfer/plan.js';
import {
  type ConflictPolicy,
  pendingFiles,
  runTransfer,
  type TransferProgress,
  type TransferResult,
} from '../transfer/run.js';
import type { Stage } from './stage.js';

export interface RelayTarget {
  key: string;
  label: string;
  plan: TransferPlan;
  reconnect?: () => Promise<FileSystem>;
}

export type TargetState = 'running' | 'retrying' | TransferResult['status'];

export interface TargetProgress {
  key: string;
  label: string;
  state: TargetState;
  attempt: number;
  progress: TransferProgress | undefined;
  result: TransferResult | undefined;
}

export interface RelayProgress {
  neededBytes: number;
  fetchedBytes: number;
  directBytes: number;
  stagedBytes: number;
  speed: number;
  targets: TargetProgress[];
}

export interface RelayOptions {
  policy: ConflictPolicy;
  signal?: AbortSignal;
  onProgress?: (progress: RelayProgress) => void;
  reconnectSource?: () => Promise<FileSystem>;
  retries?: number;
  retryDelayMs?: number;
}

export interface RelayOutcome {
  key: string;
  label: string;
  plan: TransferPlan;
  result: TransferResult;
  attempts: number;
}

const PROGRESS_INTERVAL = 100;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY = 1500;

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function combine(previous: TransferResult | undefined, next: TransferResult): TransferResult {
  if (!previous) return next;
  return { ...next, files: previous.files + next.files, bytes: previous.bytes + next.bytes };
}

export function neededBytes(targets: RelayTarget[], policy: ConflictPolicy): number {
  const sizes = new Map<string, number>();
  for (const target of targets) {
    for (const file of pendingFiles(target.plan, policy)) sizes.set(file.source, file.size);
  }
  let total = 0;
  for (const size of sizes.values()) total += size;
  return total;
}

async function replan(
  plan: TransferPlan,
  stage: Stage,
  target: FileSystem,
  finished: Set<string>,
): Promise<TransferPlan> {
  const fresh = await planTransfer({
    ...plan.spec,
    source: stage,
    target,
    placement: plan.placement,
  });
  const keep = (file: PlannedFile) => !finished.has(file.source);
  const files = fresh.files.filter(keep);
  return {
    ...fresh,
    files,
    conflicts: fresh.conflicts.filter(keep),
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

export async function runRelay(
  stage: Stage,
  targets: RelayTarget[],
  options: RelayOptions,
): Promise<RelayOutcome[]> {
  const meter = new SpeedMeter();
  const needed = neededBytes(targets, options.policy);
  const rows: TargetProgress[] = targets.map((target) => ({
    key: target.key,
    label: target.label,
    state: 'running',
    attempt: 0,
    progress: undefined,
    result: undefined,
  }));
  let counted = 0;
  const emit = () => {
    const { fetched, direct, stored } = stage.stats;
    meter.add(fetched - counted);
    counted = fetched;
    options.onProgress?.({
      neededBytes: needed,
      fetchedBytes: fetched,
      directBytes: direct,
      stagedBytes: stored,
      speed: meter.sample(),
      targets: rows.map((row) => ({ ...row })),
    });
  };
  const ticker = setInterval(emit, PROGRESS_INTERVAL);
  ticker.unref();

  let restoring: Promise<void> | undefined;
  const restoreSource = async () => {
    if (!stage.closed) return;
    const reconnect = options.reconnectSource;
    if (!reconnect) throw new AppError(`Connection to ${stage.label} was lost`);
    restoring ??= reconnect()
      .then((fs) => stage.replaceSource(fs))
      .finally(() => {
        restoring = undefined;
      });
    await restoring;
  };

  try {
    return await Promise.all(
      targets.map((target, index) =>
        relayTo(stage, target, rows[index] as TargetProgress, options, restoreSource),
      ),
    );
  } finally {
    clearInterval(ticker);
    emit();
  }
}

async function relayTo(
  stage: Stage,
  target: RelayTarget,
  row: TargetProgress,
  options: RelayOptions,
  restoreSource: () => Promise<void>,
): Promise<RelayOutcome> {
  const { policy, signal } = options;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const delay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY;
  const owed = new Set(pendingFiles(target.plan, policy).map((file) => file.source));
  for (const file of owed) stage.expect(file);
  const finished = new Set<string>();
  const started = performance.now();
  let plan = target.plan;
  let total: TransferResult | undefined;

  try {
    for (;;) {
      row.state = 'running';
      const result = await runTransfer(plan, {
        policy,
        signal,
        onProgress: (progress) => {
          row.progress = progress;
        },
        onFileDone: (file) => {
          finished.add(file.source);
          if (owed.delete(file.source)) void stage.release(file.source);
        },
      });
      total = combine(total, result);
      const recoverable =
        result.lost === 'source' ? options.reconnectSource !== undefined : !!target.reconnect;
      if (!result.lost || !recoverable || row.attempt >= retries || signal?.aborted) break;

      row.state = 'retrying';
      row.attempt++;
      try {
        await pause(delay * row.attempt, signal);
        let destination = plan.spec.target;
        if (result.lost === 'source') await restoreSource();
        else destination = await (target.reconnect as () => Promise<FileSystem>)();
        plan = await replan(plan, stage, destination, finished);
      } catch (error) {
        total = signal?.aborted
          ? { ...total, status: 'cancelled' }
          : { ...total, status: 'failed', error: describeError(error) };
        break;
      }
    }
  } finally {
    for (const file of owed) void stage.release(file);
  }

  const result = { ...(total as TransferResult), durationMs: performance.now() - started };
  row.state = result.status;
  row.result = result;
  return {
    key: target.key,
    label: target.label,
    plan: target.plan,
    result,
    attempts: row.attempt + 1,
  };
}
