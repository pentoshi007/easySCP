import { EventEmitter } from 'node:events';
import type { Client, SFTPWrapper } from 'ssh2';
import { AppError, CancelledError } from '../core/errors.js';
import { type Host, touchHost } from '../core/hosts.js';
import { type Connection, type ConnectOptions, connect } from './connect.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface StreamExecOptions {
  signal?: AbortSignal;
  onLine: (line: string) => boolean | undefined;
}

export class Session {
  readonly host: Host;
  readonly sftp: SFTPWrapper;
  readonly home: string;
  readonly windows: boolean;
  private readonly connection: Connection;
  private readonly events = new EventEmitter();
  private isClosed = false;

  private constructor(connection: Connection, sftp: SFTPWrapper, home: string) {
    this.connection = connection;
    this.host = connection.host;
    this.sftp = sftp;
    this.home = home;
    this.windows = /^\/?[A-Za-z]:/.test(home);
    const markClosed = () => {
      if (this.isClosed) return;
      this.isClosed = true;
      this.events.emit('close');
    };
    connection.client.once('close', markClosed);
    sftp.once('close', markClosed);
    sftp.on('error', () => markClosed());
  }

  static async open(host: Host, options: ConnectOptions): Promise<Session> {
    const connection = await connect(host, options);
    try {
      options.interaction.status('Starting SFTP');
      const sftp = await openSftp(connection.client);
      const home = await realpath(sftp, '.');
      await touchHost(host.id).catch(() => undefined);
      return new Session(connection, sftp, home);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  get client(): Client {
    return this.connection.client;
  }

  get serverSoftware(): string | undefined {
    const version = (this.connection.client as unknown as { _remoteVer?: unknown })._remoteVer;
    return typeof version === 'string' && version ? version : undefined;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  onClose(listener: () => void): () => void {
    this.events.on('close', listener);
    return () => this.events.off('close', listener);
  }

  close(): void {
    if (this.isClosed) return;
    try {
      this.sftp.end();
    } catch {}
    this.connection.close();
  }

  exec(command: string, signal?: AbortSignal): Promise<ExecResult> {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    return this.run(command, signal, (stream) => {
      stream.on('data', (chunk: Buffer) => stdout.push(chunk));
      stream.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    }).then((code) => ({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  }

  execLines(command: string, options: StreamExecOptions): Promise<number | null> {
    let pending = '';
    return this.run(command, options.signal, (stream) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        const lines = (pending + chunk).split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (options.onLine(line) === false) {
            stream.close();
            return;
          }
        }
      });
      stream.on('end', () => {
        if (pending) options.onLine(pending);
      });
      stream.stderr.resume();
    });
  }

  private run(
    command: string,
    signal: AbortSignal | undefined,
    attach: (stream: import('ssh2').ClientChannel) => void,
  ): Promise<number | null> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new CancelledError());
        return;
      }
      this.client.exec(command, (error, stream) => {
        if (error) {
          reject(new AppError('Remote command failed to start', error.message));
          return;
        }
        const onAbort = () => {
          stream.close();
          reject(new CancelledError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        attach(stream);
        stream.on('close', (code: number | null) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(typeof code === 'number' ? code : null);
        });
      });
    });
  }
}

function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(
          new AppError(
            'The server refused to start SFTP',
            'Make sure the SFTP subsystem is enabled in the server sshd_config.',
          ),
        );
      } else {
        resolve(sftp);
      }
    });
  });
}

function realpath(sftp: SFTPWrapper, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(target, (error, resolved) => (error ? reject(error) : resolve(resolved)));
  });
}
