import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { describeError } from '../../core/errors.js';
import type { Entry, FileSystem } from '../../fs/types.js';
import { DeepIndex, type DirCache } from './cache.js';

export interface Listing {
  dir: string;
  entries: Entry[] | undefined;
  error: string | undefined;
}

export function useListing(cache: DirCache, dir: string, version: number): Listing {
  const [state, setState] = useState<Listing>(() => ({
    dir,
    entries: cache.peek(dir),
    error: undefined,
  }));

  useEffect(() => {
    let live = true;
    const cached = version === 0 ? cache.peek(dir) : undefined;
    setState({ dir, entries: cached, error: undefined });
    if (!cached) {
      cache.load(dir, version > 0).then(
        (entries) => {
          if (live) setState({ dir, entries, error: undefined });
        },
        (error: unknown) => {
          if (live) setState({ dir, entries: undefined, error: describeError(error).message });
        },
      );
    }
    return () => {
      live = false;
    };
  }, [cache, dir, version]);

  if (state.dir === dir) return state;
  return { dir, entries: cache.peek(dir), error: undefined };
}

const noop = () => () => {};

export interface DeepView {
  index: DeepIndex;
  version: number;
}

export function useDeepIndex(fs: FileSystem, root: string, active: boolean): DeepView | undefined {
  const indexes = useRef(new Map<string, DeepIndex>());

  useEffect(() => {
    const owned = indexes.current;
    return () => {
      for (const index of owned.values()) index.abort();
      owned.clear();
    };
  }, []);

  let index: DeepIndex | undefined;
  if (active) {
    index = indexes.current.get(root);
    if (!index || index.status === 'error') {
      index?.abort();
      index = new DeepIndex(fs, root);
      indexes.current.set(root, index);
    }
  }

  const subscribe = useMemo(
    () => (index ? (listener: () => void) => index.subscribe(listener) : noop),
    [index],
  );
  const version = useSyncExternalStore(subscribe, () => index?.version ?? -1);
  return useMemo(() => (index ? { index, version } : undefined), [index, version]);
}
