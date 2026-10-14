import { AppError } from '../core/errors.js';
import { type Host, sameName } from '../core/hosts.js';

export interface CopyDestination {
  host: Host;
  dir: string | undefined;
}

export interface CopyRequest {
  source: Host | undefined;
  paths: string[];
  destinations: CopyDestination[];
}

const USAGE = 'Example: easyscp copy web1:/srv/app.tar web2 web3:/opt';

function splitMachine(token: string) {
  const colon = token.indexOf(':');
  if (colon <= 0) return { name: token, path: undefined, qualified: false };
  return {
    name: token.slice(0, colon),
    path: token.slice(colon + 1) || undefined,
    qualified: true,
  };
}

export interface SendRequest {
  paths: string[];
  destinations: CopyDestination[];
}

export async function parseSendTokens(
  tokens: string[],
  hosts: Host[],
  isLocalPath: (token: string) => Promise<boolean>,
): Promise<SendRequest> {
  const paths: string[] = [];
  const destinations: CopyDestination[] = [];
  for (const token of tokens) {
    const { name, path, qualified } = splitMachine(token);
    const host = hosts.find((candidate) => sameName(candidate.name, name));
    if (host) {
      if (!destinations.some((entry) => entry.host.id === host.id && entry.dir === path)) {
        destinations.push({ host, dir: path });
      }
      continue;
    }
    const looksLikeMachine = qualified && name.length > 1 && !/[\\/]/.test(name);
    if (looksLikeMachine && !(await isLocalPath(token))) {
      throw new AppError(
        `No saved machine named "${name}"`,
        'Run `easyscp list` to see saved machines.',
      );
    }
    paths.push(token);
  }
  return { paths, destinations };
}

export function parseCopyTokens(tokens: string[], hosts: Host[]): CopyRequest {
  const find = (name: string) => hosts.find((host) => sameName(host.name, name));
  const unknown = (name: string) =>
    new AppError(`No saved machine named "${name}"`, 'Run `easyscp list` to see saved machines.');
  const [first, ...rest] = tokens;
  if (first === undefined) return { source: undefined, paths: [], destinations: [] };

  const head = splitMachine(first);
  const source = find(head.name);
  if (!source) throw unknown(head.name);
  const paths = head.path ? [head.path] : [];
  const destinations: CopyDestination[] = [];

  for (const token of rest) {
    const { name, path, qualified } = splitMachine(token);
    const host = find(name);
    if (host && host.id === source.id) {
      if (path === undefined || destinations.length > 0) {
        throw new AppError(
          `${source.name} is the machine you are copying from`,
          'Choose other machines as destinations.',
        );
      }
      paths.push(path);
    } else if (host) {
      if (!destinations.some((entry) => entry.host.id === host.id && entry.dir === path)) {
        destinations.push({ host, dir: path });
      }
    } else if (qualified) {
      throw unknown(name);
    } else if (destinations.length === 0) {
      paths.push(token);
    } else {
      throw new AppError(
        `"${token}" is not a saved machine`,
        `Files come before machines. ${USAGE}`,
      );
    }
  }
  return { source, paths, destinations };
}
