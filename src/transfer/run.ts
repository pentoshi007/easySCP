import { AppError, describeError, type ErrorReport, isCancelled } from '../core/errors.js';
import { partName } from '../fs/names.js';
import { ensureDir, parentDir, uniqueName } from '../fs/ops.js';
import type { FileSystem, Reader, Writer } from '../fs/types.js';
import { mapLimit } from '../util/concurrency.js';
import { SpeedMeter } from './meter.js';
import { isNewer, type PlannedFile, type TransferPlan } from './plan.js';

export type ConflictPolicy = 'overwrite' | 'skip' | 'rename' | 'newer' | 'resume';

export interface ActiveFile {
  relative: string;
  size: number;
  done: number;
}

export interface TransferProgress {
  totalBytes: number;
  doneBytes: number;
  totalFiles: number;
  doneFiles: number;
  failedFiles: number;
  active: ActiveFile[];
  speed: number;
  etaMs: number | undefined;
  elapsedMs: number;
}

export interface FailedFile {
  path: string;
  message: string;
}

export type TransferStatus = 'done' | 'partial' | 'failed' | 'cancelled';

export interface TransferResult {
  status: TransferStatus;
  files: number;
  skipped: number;
  failed: FailedFile[];
  bytes: number;
  durationMs: number;
  keptPartials: number;
  error?: ErrorReport;
}

export interface RunOptions {
  policy?: ConflictPolicy;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
  concurrency?: number;
}

interface Task {
  file: PlannedFile;
  rename: boolean;
  appendExisting: boolean;
}

const TAIL_CHECK = 64 * 1024;
const RESUME_OVERLAP = 4 * 1024 * 1024;
const KEEP_PARTIAL = 8 * 1024 * 1024;
const PROGRESS_INTERVAL = 100;
const CANCEL_GRACE = 4000;
const DIR_CONCURRENCY = 16;
const DEFAULT_CONCURRENCY = 4;

function resolveTasks(
  plan: TransferPlan,
  policy: ConflictPolicy,
): { tasks: Task[]; skipped: number } {
  const tasks: Task[] = [];
  let skipped = 0;
  for (const file of plan.files) {
    const existing = file.existing;
    if (!existing) {
      tasks.push({ file, rename: false, appendExisting: false });
      continue;
    }
    switch (policy) {
      case 'overwrite':
        tasks.push({ file, rename: false, appendExisting: false });
        break;
      case 'rename':
        tasks.push({ file, rename: true, appendExisting: false });
        break;
      case 'newer':
        if (isNewer(file)) tasks.push({ file, rename: false, appendExisting: false });
        else skipped++;
        break;
      case 'resume':
        if (existing.size === file.size) skipped++;
        else tasks.push({ file, rename: false, appendExisting: existing.size < file.size });
        break;
      default:
        skipped++;
    }
  }
  return { tasks, skipped };
}

function pipelineShape(a: FileSystem, b: FileSystem): { chunk: number; parallel: number } {
  const remote = [a, b].filter((fs) => !fs.local);
  const sides = remote.length > 0 ? remote : [a];
  return {
    chunk: Math.min(...sides.map((fs) => fs.chunkSize)),
    parallel: Math.min(...sides.map((fs) => fs.parallelChunks)),
  };
}

async function readFully(reader: Reader, buffer: Buffer, length: number, position: number) {
  let filled = 0;
  while (filled < length) {
    const count = await reader.read(buffer, filled, length - filled, position + filled);
    if (count === 0) throw new AppError('The file changed size while it was being copied');
    filled += count;
  }
}

async function readTail(
  fs: FileSystem,
  file: string,
  end: number,
  length: number,
): Promise<Buffer> {
  const reader = await fs.openRead(file);
  try {
    const buffer = Buffer.alloc(length);
    await readFully(reader, buffer, length, end - length);
    return buffer;
  } finally {
    await reader.close().catch(() => undefined);
  }
}

function resumePoint(size: number): number {
  return Math.max(0, size - RESUME_OVERLAP);
}

async function canResume(plan: TransferPlan, file: PlannedFile, work: string, offset: number) {
  if (offset <= 0 || offset >= file.size) return false;
  const length = Math.min(TAIL_CHECK, offset);
  try {
    const [ours, theirs] = await Promise.all([
      readTail(plan.spec.source, file.source, offset, length),
      readTail(plan.spec.target, work, offset, length),
    ]);
    return ours.equals(theirs);
  } catch {
    return false;
  }
}

async function pump(
  reader: Reader,
  writer: Writer,
  from: number,
  size: number,
  shape: { chunk: number; parallel: number },
  signal: AbortSignal,
  onBytes: (count: number) => void,
): Promise<void> {
  let next = from;
  let failed = false;
  let issued = Promise.resolve();
  const worker = async () => {
    const buffer = Buffer.allocUnsafe(shape.chunk);
    while (!failed) {
      signal.throwIfAborted();
      const offset = next;
      if (offset >= size) return;
      next += shape.chunk;
      const length = Math.min(shape.chunk, size - offset);
      const turn = issued;
      let release = () => {};
      issued = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await readFully(reader, buffer, length, offset);
        await turn;
        if (failed) return;
        signal.throwIfAborted();
        const writing = writer.write(buffer, 0, length, offset);
        release();
        await writing;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        release();
      }
      onBytes(length);
    }
  };
  const workers = Math.max(1, Math.min(shape.parallel, Math.ceil((size - from) / shape.chunk)));
  const results = await Promise.allSettled(Array.from({ length: workers }, worker));
  const rejection = results.find((result) => result.status === 'rejected');
  if (rejection) throw (rejection as PromiseRejectedResult).reason;
}

async function createDirs(target: FileSystem, plan: TransferPlan, signal: AbortSignal) {
  await ensureDir(target, plan.anchor);
  const byDepth = new Map<number, string[]>();
  for (const dir of plan.dirs) {
    const depth = dir.split(/[\\/]/).length;
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), dir]);
  }
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    signal.throwIfAborted();
    await mapLimit(byDepth.get(depth) ?? [], DIR_CONCURRENCY, async (dir) => {
      try {
        await target.mkdir(dir);
      } catch (error) {
        if ((await target.stat(dir))?.kind !== 'dir') throw error;
      }
    });
  }
}

function withTimeout(task: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    task.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ]);
}

export async function runTransfer(
  plan: TransferPlan,
  options: RunOptions = {},
): Promise<TransferResult> {
  const { source, target } = plan.spec;
  const started = performance.now();
  const internal = new AbortController();
  const onUserAbort = () => internal.abort(options.signal?.reason);
  if (options.signal?.aborted) onUserAbort();
  options.signal?.addEventListener('abort', onUserAbort, { once: true });

  const { tasks, skipped } = resolveTasks(plan, options.policy ?? 'skip');
  const shape = pipelineShape(source, target);
  const meter = new SpeedMeter();
  const active = new Map<number, ActiveFile>();
  const failed: FailedFile[] = [];
  const preserveMode = !(source.local && process.platform === 'win32');
  const modeFor = (file: PlannedFile) =>
    preserveMode && file.mode & 0o700 ? file.mode & 0o777 : undefined;
  let doneBytes = 0;
  let doneFiles = 0;
  let keptPartials = 0;
  let fatal: unknown;
  let lastSnapshot = '';

  const totalBytes = tasks.reduce((sum, task) => sum + task.file.size, 0);
  const snapshot = (): TransferProgress => {
    const speed = meter.sample();
    const remaining = totalBytes - doneBytes;
    return {
      totalBytes,
      doneBytes,
      totalFiles: tasks.length,
      doneFiles,
      failedFiles: failed.length,
      active: [...active.values()].map((file) => ({ ...file })),
      speed,
      etaMs: speed > 0 ? (remaining / speed) * 1000 : undefined,
      elapsedMs: performance.now() - started,
    };
  };
  const emit = () => {
    if (!options.onProgress) return;
    const progress = snapshot();
    const key = `${progress.doneBytes}:${progress.doneFiles}:${progress.failedFiles}:${active.size}`;
    if (key === lastSnapshot && progress.speed === 0) return;
    lastSnapshot = key;
    options.onProgress(progress);
  };
  const ticker = setInterval(emit, PROGRESS_INTERVAL);
  ticker.unref();

  const copy = async (task: Task, id: number) => {
    const { file } = task;
    let finalPath = file.target;
    const dir = parentDir(target, finalPath) ?? plan.anchor;
    if (task.rename) {
      finalPath = target.path.join(
        dir,
        await uniqueName(target, dir, target.path.basename(finalPath)),
      );
    }
    let direct = task.appendExisting;
    let work = direct
      ? finalPath
      : target.path.join(dir, partName(target.path.basename(finalPath)));
    let offset = 0;
    if (direct) {
      const point = resumePoint(file.existing?.size ?? 0);
      offset = (await canResume(plan, file, work, point)) ? point : 0;
      if (offset === 0) {
        direct = false;
        work = target.path.join(dir, partName(target.path.basename(finalPath)));
      }
    } else if (!task.rename && (await canResume(plan, file, work, resumePoint(file.partial)))) {
      offset = resumePoint(file.partial);
    }

    const entry: ActiveFile = { relative: file.relative, size: file.size, done: offset };
    active.set(id, entry);
    doneBytes += offset;
    let written = 0;
    const credit = (count: number) => {
      written += count;
      entry.done += count;
      doneBytes += count;
      meter.add(count);
    };

    try {
      const reader = await source.openRead(file.source);
      try {
        const writer = await target.openWrite(work, offset > 0);
        let finished = false;
        try {
          await pump(reader, writer, offset, file.size, shape, internal.signal, credit);
          await writer.finish({ mtime: file.mtime, mode: modeFor(file) });
          finished = true;
        } finally {
          if (finished) await writer.close();
          else await writer.close().catch(() => undefined);
        }
      } finally {
        await reader.close().catch(() => undefined);
      }
      if (!direct) await target.rename(work, finalPath);
      doneFiles++;
    } catch (error) {
      doneBytes -= offset + written;
      const keep = internal.signal.aborted && offset + written >= KEEP_PARTIAL;
      if (keep && !direct) keptPartials++;
      if (!direct && !keep && !target.closed) {
        await withTimeout(target.removeFile(work), 2000);
      }
      throw error;
    } finally {
      active.delete(id);
    }
  };

  const markFatal = (error: unknown) => {
    if (fatal === undefined) fatal = error;
    internal.abort(error);
  };

  try {
    await createDirs(target, plan, internal.signal);
    const work = mapLimit(
      tasks,
      options.concurrency ?? DEFAULT_CONCURRENCY,
      async (task, index) => {
        if (internal.signal.aborted) return;
        try {
          await copy(task, index);
        } catch (error) {
          if (internal.signal.aborted || isCancelled(error)) return;
          if (source.closed || target.closed) {
            const lost = source.closed ? source : target;
            markFatal(
              new AppError(
                `Connection to ${lost.label} was lost`,
                'Run the same transfer again to resume where it stopped.',
              ),
            );
            return;
          }
          failed.push({ path: task.file.relative, message: describeError(error).message });
        }
      },
    );
    const grace = new Promise<void>((resolve) => {
      const wait = () => setTimeout(resolve, CANCEL_GRACE).unref();
      if (internal.signal.aborted) wait();
      else internal.signal.addEventListener('abort', wait, { once: true });
    });
    await Promise.race([work, grace]);
  } catch (error) {
    if (!internal.signal.aborted) markFatal(error);
  } finally {
    clearInterval(ticker);
    options.signal?.removeEventListener('abort', onUserAbort);
  }
  emit();

  const cancelled = options.signal?.aborted === true;
  const durationMs = performance.now() - started;
  const result: TransferResult = {
    status: 'done',
    files: doneFiles,
    skipped,
    failed,
    bytes: meter.bytes,
    durationMs,
    keptPartials,
  };
  if (cancelled) result.status = 'cancelled';
  else if (fatal !== undefined) {
    result.status = 'failed';
    result.error = describeError(fatal);
  } else if (failed.length > 0) {
    result.status = doneFiles > 0 ? 'partial' : 'failed';
  }
  return result;
}
