import type { Duplex } from 'node:stream';
import { Client, type ConnectConfig } from 'ssh2';
import { AppError, CancelledError } from '../core/errors.js';
import { type Host, hostLabel, requireHost } from '../core/hosts.js';
import { debugEnabled, debugLog } from '../core/log.js';
import { Authenticator } from './auth.js';
import type { Interaction } from './interaction.js';
import {
  checkHostKey,
  knownHostName,
  knownKeyTypes,
  preferredHostKeyAlgorithms,
  trustHostKey,
} from './knownHosts.js';

export interface ConnectOptions {
  interaction: Interaction;
  signal?: AbortSignal;
  timeoutMs?: number;
  compress?: boolean;
}

export interface Connection {
  readonly host: Host;
  readonly client: Client;
  close(): void;
}

const DEFAULT_TIMEOUT = 20_000;

class Watchdog {
  private timer: NodeJS.Timeout | undefined;
  private paused = 0;
  private active = true;

  constructor(
    private readonly ms: number,
    private readonly onTimeout: () => void,
  ) {
    this.arm();
  }

  async pause<T>(task: () => Promise<T>): Promise<T> {
    this.paused++;
    this.clear();
    try {
      return await task();
    } finally {
      this.paused--;
      this.arm();
    }
  }

  stop(): void {
    this.active = false;
    this.clear();
  }

  private arm(): void {
    this.clear();
    if (this.active && this.paused === 0) this.timer = setTimeout(this.onTimeout, this.ms);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function forward(client: Client, host: Host): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host.hostname, host.port, (error, stream) => {
      if (error) {
        reject(
          new AppError(`Jump host could not reach ${host.hostname}:${host.port}`, error.message),
        );
      } else {
        resolve(stream);
      }
    });
  });
}

function explainFailure(error: Error, host: Host): Error {
  if (/too many authentication failures/i.test(error.message)) {
    return new AppError(
      'Too many authentication failures',
      `The server gave up before the right key was tried. Pick a specific key with \`easyscp edit ${host.name}\`.`,
    );
  }
  return error;
}

async function algorithmsFor(host: Host, compress: boolean): Promise<ConnectConfig['algorithms']> {
  const preferred = preferredHostKeyAlgorithms(await knownKeyTypes(host.hostname, host.port));
  const algorithms: NonNullable<ConnectConfig['algorithms']> = {};
  if (preferred.length) {
    algorithms.serverHostKey = { remove: preferred, prepend: preferred } as never;
  }
  if (compress) algorithms.compress = ['zlib@openssh.com', 'zlib', 'none'];
  return algorithms;
}

function handshake(
  host: Host,
  options: ConnectOptions,
  sock: Duplex | undefined,
  via: string | undefined,
): Promise<Client> {
  const { interaction, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    const client = new Client();
    let settled = false;
    let hostKeyError: Error | undefined;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      signal?.removeEventListener('abort', onAbort);
      client.removeAllListeners('ready');
      client.on('error', () => {});
      client.destroy();
      reject(error);
    };
    const onAbort = () => fail(new CancelledError());
    const watchdog = new Watchdog(options.timeoutMs ?? DEFAULT_TIMEOUT, () =>
      fail(
        new AppError(
          `Timed out connecting to ${host.hostname}:${host.port}`,
          'The host may be offline, or a firewall is dropping the connection.',
        ),
      ),
    );
    signal?.addEventListener('abort', onAbort, { once: true });

    const auth = new Authenticator({
      host,
      ask: (question) => watchdog.pause(() => interaction.askSecret({ ...question, host })),
      onStatus: (message) => interaction.status(message),
    });

    client.on('ready', () => {
      if (settled) return;
      settled = true;
      watchdog.stop();
      signal?.removeEventListener('abort', onAbort);
      auth.commit().finally(() => resolve(client));
    });

    client.on('error', (error: Error & { level?: string }) => {
      debugLog(`[${host.name}] error(${error.level ?? '-'}): ${error.message}`);
      if (error.level === 'agent') {
        auth.note(`SSH agent unavailable: ${error.message}`);
        return;
      }
      if (error.level === 'client-authentication') {
        if (auth.exhausted) fail(auth.failure());
        else auth.note(error.message);
        return;
      }
      if (hostKeyError) {
        fail(hostKeyError);
        return;
      }
      fail(explainFailure(error, host));
    });

    client.on('close', () => {
      if (hostKeyError) fail(hostKeyError);
      else if (auth.exhausted) fail(auth.failure());
      else fail(new AppError(`Connection to ${host.hostname} closed unexpectedly`));
    });

    const verifyHostKey = (key: Buffer, verify: (valid: boolean) => void) => {
      const address = knownHostName(host.hostname, host.port);
      checkHostKey(host.hostname, host.port, key)
        .then(async (check) => {
          if (check.status === 'trusted') return true;
          if (check.status === 'revoked') {
            hostKeyError = new AppError(
              `The host key for ${address} has been revoked`,
              'Refusing to connect. Contact the server administrator.',
            );
            return false;
          }
          const accepted = await watchdog.pause(() =>
            interaction.confirmHostKey({
              host,
              address,
              key: check.key,
              status: check.status as 'unknown' | 'changed',
              knownTypes: check.knownTypes,
            }),
          );
          if (!accepted) {
            hostKeyError =
              check.status === 'changed'
                ? new AppError(
                    `Host key for ${address} has changed`,
                    'This could be a man-in-the-middle attack, or the server was reinstalled. Verify the fingerprint with the server owner before trusting it.',
                  )
                : new AppError(`Host key for ${address} was not trusted`, 'Connection aborted.');
            return false;
          }
          await trustHostKey(host.hostname, host.port, check.key);
          return true;
        })
        .then(verify, (error: Error) => {
          hostKeyError = error;
          verify(false);
        });
    };

    interaction.status(
      via
        ? `Connecting to ${host.name} via ${via}`
        : `Connecting to ${host.name} (${hostLabel(host)})`,
    );

    algorithmsFor(host, options.compress === true).then(
      (algorithms) => {
        if (settled) return;
        const config: ConnectConfig = {
          host: host.hostname,
          port: host.port,
          username: host.user,
          readyTimeout: 0,
          keepaliveInterval: 15_000,
          keepaliveCountMax: 4,
          hostVerifier: verifyHostKey,
          authHandler: auth.handler,
          algorithms,
        };
        if (sock) config.sock = sock as never;
        if (debugEnabled()) config.debug = (message) => debugLog(`[${host.name}] ${message}`);
        try {
          client.connect(config);
        } catch (error) {
          fail(error as Error);
        }
      },
      (error: Error) => fail(error),
    );
  });
}

export async function connect(host: Host, options: ConnectOptions): Promise<Connection> {
  return open(host, options, [host.id]);
}

async function open(host: Host, options: ConnectOptions, chain: string[]): Promise<Connection> {
  if (!host.jump) {
    const client = await handshake(host, options, undefined, undefined);
    return { host, client, close: () => client.end() };
  }

  const jumpHost = await requireHost(host.jump);
  if (chain.includes(jumpHost.id)) {
    throw new AppError(
      `Jump host loop detected at "${jumpHost.name}"`,
      `Fix the jump host of "${host.name}" with \`easyscp edit ${host.name}\`.`,
    );
  }
  const jump = await open(jumpHost, options, [...chain, jumpHost.id]);
  try {
    const stream = await forward(jump.client, host);
    const client = await handshake(host, options, stream, jumpHost.name);
    client.once('close', () => jump.close());
    return {
      host,
      client,
      close: () => {
        client.end();
        jump.close();
      },
    };
  } catch (error) {
    jump.close();
    throw error;
  }
}
