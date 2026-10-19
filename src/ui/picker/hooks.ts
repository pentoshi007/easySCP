import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { FileSystem } from '../../fs/types.js';
import { DeepIndex, type DirCache, type DirSnapshot } from './cache.js';

export interface Listing extends DirSnapshot {
  dir: string;
}

const FRESH_FOR = 1000;
const LOCAL_POLL_INTERVAL = 2000;
const REMOTE_POLL_INTERVAL = 4000;
const MAX_POLL_INTERVAL = 30_000;
const POLL_COST_FACTOR = 10;

function pollDelay(fs: FileSystem, took: number): number {
  const base = fs.local ? LOCAL_POLL_INTERVAL : REMOTE_POLL_INTERVAL;
  return Math.min(MAX_POLL_INTERVAL, Math.max(base, took * POLL_COST_FACTOR));
}

export function useListing(cache: DirCache, dir: string, live = true): Listing {
  const subscribe = useCallback(
    (listener: () => void) => cache.subscribe(dir, listener),
    [cache, dir],
  );
  const snapshot = useSyncExternalStore(subscribe, () => cache.snapshot(dir));

  useEffect(() => {
    void cache.revalidate(dir, FRESH_FOR);
  }, [cache, dir]);

  useEffect(() => {
    if (!live) return;
    let active = true;
    let timer: NodeJS.Timeout | undefined;
    const poll = async () => {
      if (cache.fs.closed) return;
      const started = performance.now();
      await cache.revalidate(dir, FRESH_FOR);
      if (active) timer = setTimeout(poll, pollDelay(cache.fs, performance.now() - started));
    };
    timer = setTimeout(poll, pollDelay(cache.fs, 0));
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [cache, dir, live]);

  return useMemo(
    () => ({ dir, entries: snapshot.entries, error: snapshot.error, revision: snapshot.revision }),
    [dir, snapshot],
  );
}

const noop = () => () => {};

export interface DeepView {
  index: DeepIndex;
  version: number;
}

interface Indexed {
  index: DeepIndex;
  generation: number;
}

export function useDeepIndex(
  fs: FileSystem,
  root: string,
  active: boolean,
  generation = 0,
): DeepView | undefined {
  const indexes = useRef(new Map<string, Indexed>());

  useEffect(() => {
    const owned = indexes.current;
    return () => {
      for (const { index } of owned.values()) index.abort();
      owned.clear();
    };
  }, []);

  let index: DeepIndex | undefined;
  if (active) {
    const known = indexes.current.get(root);
    index = known?.index;
    if (!known || known.generation !== generation || known.index.status === 'error') {
      known?.index.abort();
      index = new DeepIndex(fs, root);
      indexes.current.set(root, { index, generation });
    }
  }

  const subscribe = useMemo(
    () => (index ? (listener: () => void) => index.subscribe(listener) : noop),
    [index],
  );
  const version = useSyncExternalStore(subscribe, () => index?.version ?? -1);
  return useMemo(() => (index ? { index, version } : undefined), [index, version]);
}
