import { appFile } from './paths.js';
import { JsonStore } from './store.js';

const MAX_RECENT = 12;

interface StateFile {
  version: 1;
  recentRemote: Record<string, string[]>;
  recentLocal: string[];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

const store = new JsonStore<StateFile>({
  file: () => appFile('state.json'),
  defaults: () => ({ version: 1, recentRemote: {}, recentLocal: [] }),
  normalize: (raw) => {
    const value = (raw ?? {}) as Partial<StateFile>;
    const recentRemote: Record<string, string[]> = {};
    if (value.recentRemote && typeof value.recentRemote === 'object') {
      for (const [hostId, dirs] of Object.entries(value.recentRemote)) {
        recentRemote[hostId] = stringList(dirs);
      }
    }
    return { version: 1, recentRemote, recentLocal: stringList(value.recentLocal) };
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
