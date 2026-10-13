import { appFile } from './paths.js';
import { JsonStore } from './store.js';

const MAX_RECENT = 12;

export interface CompletionState {
  version: string;
  shells: string[];
  profiles: Record<string, string[]>;
  disabled: boolean;
}

interface StateFile {
  version: 1;
  recentRemote: Record<string, string[]>;
  recentLocal: string[];
  completion: CompletionState;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function listRecord(value: unknown): Record<string, string[]> {
  const record: Record<string, string[]> = {};
  if (value && typeof value === 'object') {
    for (const [key, list] of Object.entries(value)) record[key] = stringList(list);
  }
  return record;
}

function emptyCompletion(): CompletionState {
  return { version: '', shells: [], profiles: {}, disabled: false };
}

function normalizeCompletion(value: unknown): CompletionState {
  if (!value || typeof value !== 'object') return emptyCompletion();
  const raw = value as Partial<CompletionState>;
  return {
    version: typeof raw.version === 'string' ? raw.version : '',
    shells: stringList(raw.shells),
    profiles: listRecord(raw.profiles),
    disabled: raw.disabled === true,
  };
}

const store = new JsonStore<StateFile>({
  file: () => appFile('state.json'),
  defaults: () => ({
    version: 1,
    recentRemote: {},
    recentLocal: [],
    completion: emptyCompletion(),
  }),
  normalize: (raw) => {
    const value = (raw ?? {}) as Partial<StateFile>;
    return {
      version: 1,
      recentRemote: listRecord(value.recentRemote),
      recentLocal: stringList(value.recentLocal),
      completion: normalizeCompletion(value.completion),
    };
  },
});

function pushRecent(list: string[], entry: string): string[] {
  return [entry, ...list.filter((item) => item !== entry)].slice(0, MAX_RECENT);
}

export async function recentRemoteDirs(hostId: string): Promise<string[]> {
  return (await store.read()).recentRemote[hostId] ?? [];
}

export async function recentLocalDirs(): Promise<string[]> {
  return (await store.read()).recentLocal;
}

export async function rememberRemoteDir(hostId: string, dir: string): Promise<void> {
  await store.update((state) => {
    state.recentRemote[hostId] = pushRecent(state.recentRemote[hostId] ?? [], dir);
    return state;
  });
}

export async function rememberLocalDir(dir: string): Promise<void> {
  await store.update((state) => {
    state.recentLocal = pushRecent(state.recentLocal, dir);
    return state;
  });
}

export async function forgetHostState(hostId: string): Promise<void> {
  await store.update((state) => {
    delete state.recentRemote[hostId];
    return state;
  });
}

export async function completionState(): Promise<CompletionState> {
  return (await store.read()).completion;
}

export async function updateCompletionState(
  change: (current: CompletionState) => CompletionState,
): Promise<void> {
  await store.update((state) => {
    state.completion = change(state.completion);
    return state;
  });
}
