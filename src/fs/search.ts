import { RemoteFileSystem } from './remote.js';
import type { FileSystem } from './types.js';

export interface IndexEntry {
  path: string;
  dir: boolean;
}

export interface IndexOptions {
  signal?: AbortSignal;
  limit?: number;
  maxDepth?: number;
  onEntries: (entries: IndexEntry[]) => void;
}

export interface IndexResult {
  count: number;
  truncated: boolean;
}

export const SKIPPED_DIRS = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.cache',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.gradle',
  '.m2',
  '.rustup',
  '.cargo',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  '.nuxt',
  '.terraform',
  '.Trash',
];

const SKIPPED = new Set(SKIPPED_DIRS);
const SKIPPED_AT_ROOT = new Set(['/proc', '/sys', '/dev', '/run']);
const DEFAULT_LIMIT = 200_000;
const DEFAULT_DEPTH = 16;
const WALK_CONCURRENCY = 8;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function findCommand(root: string, maxDepth: number): string {
  const prune = SKIPPED_DIRS.map((name) => `-name ${name}`).join(' -o ');
  const script = [
    'cd -- "$1" 2>/dev/null || exit 3;',
    `exec find . -mindepth 1 -maxdepth "$2" \\( ${prune} \\) -prune`,
    '-o -type d -exec printf "%s/\\n" {} + -o -print 2>/dev/null',
  ].join(' ');
  return `sh -c ${shellQuote(script)} sh ${shellQuote(root)} ${maxDepth}`;
}

async function remoteFind(
  fs: RemoteFileSystem,
  root: string,
  options: Required<Omit<IndexOptions, 'signal'>> & { signal?: AbortSignal },
): Promise<IndexResult | undefined> {
  let count = 0;
  let truncated = false;
  let batch: IndexEntry[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    options.onEntries(batch);
    batch = [];
  };
  const timer = setInterval(flush, 100);
  try {
    const code = await fs.session.execLines(findCommand(root, options.maxDepth), {
      signal: options.signal,
      onLine: (line) => {
        if (!line.startsWith('./')) return true;
        const dir = line.endsWith('/');
        const rel = dir ? line.slice(2, -1) : line.slice(2);
        if (!rel) return true;
        batch.push({ path: rel, dir });
        count++;
        if (batch.length >= 2000) flush();
        if (count >= options.limit) {
          truncated = true;
          return false;
        }
        return true;
      },
    });
    flush();
    if (count === 0 && code !== 0 && code !== 1) return undefined;
    return { count, truncated };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return count > 0 ? { count, truncated } : undefined;
  } finally {
    clearInterval(timer);
    flush();
  }
}

function walk(
  fs: FileSystem,
  root: string,
  options: Required<Omit<IndexOptions, 'signal'>> & { signal?: AbortSignal },
): Promise<IndexResult> {
  const queue: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
  let count = 0;
  let active = 0;
  let truncated = false;
  const { signal } = options;

  return new Promise((resolve, reject) => {
    const finish = () => {
      if (signal?.aborted) reject(signal.reason);
      else if (active === 0 && (queue.length === 0 || truncated)) resolve({ count, truncated });
    };
    const pump = () => {
      while (!signal?.aborted && !truncated && active < WALK_CONCURRENCY && queue.length > 0) {
        const { rel, depth } = queue.shift() as { rel: string; depth: number };
        const absolute = rel ? fs.path.join(root, ...rel.split('/')) : root;
        active++;
        fs.scan(absolute)
          .then((children) => {
            const batch: IndexEntry[] = [];
            for (const child of children) {
              if (truncated) break;
              if (child.dir && SKIPPED.has(child.name)) continue;
              const childRel = rel ? `${rel}/${child.name}` : child.name;
              if (child.dir && SKIPPED_AT_ROOT.has(fs.path.join(root, child.name))) continue;
              batch.push({ path: childRel, dir: child.dir });
              count++;
              if (count >= options.limit) truncated = true;
              if (child.dir && depth + 1 < options.maxDepth) {
                queue.push({ rel: childRel, depth: depth + 1 });
              }
            }
            if (batch.length > 0 && !signal?.aborted) options.onEntries(batch);
          })
          .catch(() => undefined)
          .finally(() => {
            active--;
            pump();
            finish();
          });
      }
    };
    pump();
    finish();
  });
}

export async function indexTree(
  fs: FileSystem,
  root: string,
  options: IndexOptions,
): Promise<IndexResult> {
  const resolved = {
    ...options,
    limit: options.limit ?? DEFAULT_LIMIT,
    maxDepth: options.maxDepth ?? DEFAULT_DEPTH,
  };
  if (fs instanceof RemoteFileSystem && !fs.session.windows) {
    const fast = await remoteFind(fs, root, resolved);
    if (fast) return fast;
  }
  return walk(fs, root, resolved);
}
