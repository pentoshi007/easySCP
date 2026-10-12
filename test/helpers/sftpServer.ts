import { spawn } from 'node:child_process';
import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import {
  type AuthContext,
  type Connection,
  type ParsedKey,
  type PublicKeyAuthContext,
  Server,
  type SFTPWrapper,
  utils,
} from 'ssh2';
import { generateKey } from './keys.js';

const { STATUS_CODE, flagsToString } = utils.sftp;

export interface TestUser {
  username: string;
  password?: string;
  publicKey?: string;
  keyboardInteractive?: boolean;
}

export interface TestServerOptions {
  root: string;
  users: TestUser[];
  home?: string;
  allowForwarding?: boolean;
  supportsExec?: boolean;
}

export interface TestServer {
  port: number;
  hostKey: ParsedKey;
  connections: number;
  authAttempts: string[];
  commands: string[];
  close(): Promise<void>;
}

type Handle = { kind: 'file'; fd: fs.FileHandle } | { kind: 'dir'; dir: string; done: boolean };

function statusFor(error: unknown): number {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return STATUS_CODE.NO_SUCH_FILE;
  if (code === 'EACCES' || code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function toAttrs(stats: Stats) {
  return {
    mode: stats.mode,
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function longname(name: string, stats: Stats): string {
  const type = stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : '-';
  return `${type}rw-r--r--    1 0        0        ${stats.size} Jan 01 00:00 ${name}`;
}

function serveSftp(sftp: SFTPWrapper, root: string, home: string): void {
  const handles = new Map<number, Handle>();
  let nextHandle = 1;

  const virtual = (input: string) => path.posix.resolve(home, input || '.');
  const local = (input: string) => path.join(root, ...virtual(input).split('/').filter(Boolean));
  const handleId = (buffer: Buffer) => (buffer.length === 4 ? buffer.readUInt32BE(0) : -1);
  const allocate = (handle: Handle) => {
    const id = nextHandle++;
    handles.set(id, handle);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(id, 0);
    return buffer;
  };
  const guard =
    <A extends unknown[]>(fn: (reqid: number, ...args: A) => Promise<void>) =>
    (reqid: number, ...args: A) => {
      fn(reqid, ...args).catch((error) => sftp.status(reqid, statusFor(error)));
    };
  const ok = (reqid: number) => sftp.status(reqid, STATUS_CODE.OK);

  sftp.on(
    'REALPATH',
    guard(async (reqid, target: string) => {
      const resolved = virtual(target);
      sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} as never }]);
    }),
  );
  for (const event of ['STAT', 'LSTAT'] as const) {
    sftp.on(
      event,
      guard(async (reqid, target: string) => {
        const stats =
          event === 'STAT' ? await fs.stat(local(target)) : await fs.lstat(local(target));
        sftp.attrs(reqid, toAttrs(stats));
      }),
    );
  }
  sftp.on(
    'FSTAT',
    guard(async (reqid, buffer: Buffer) => {
      const handle = handles.get(handleId(buffer));
      if (handle?.kind !== 'file') throw Object.assign(new Error('bad handle'), { code: 'EBADF' });
      sftp.attrs(reqid, toAttrs(await handle.fd.stat()));
    }),
  );
  sftp.on(
    'OPEN',
    guard(async (reqid, target: string, flags: number, attrs: { mode?: number }) => {
      const mode = flagsToString(flags) ?? 'r';
      const fd = await fs.open(local(target), mode, attrs.mode ?? 0o644);
      sftp.handle(reqid, allocate({ kind: 'file', fd }));
    }),
  );
  sftp.on(
    'READ',
    guard(async (reqid, buffer: Buffer, offset: number, length: number) => {
      const handle = handles.get(handleId(buffer));
      if (handle?.kind !== 'file') throw Object.assign(new Error('bad handle'), { code: 'EBADF' });
      const data = Buffer.alloc(length);
      const { bytesRead } = await handle.fd.read(data, 0, length, offset);
      if (bytesRead === 0) sftp.status(reqid, STATUS_CODE.EOF);
      else sftp.data(reqid, data.subarray(0, bytesRead));
    }),
  );
  sftp.on(
    'WRITE',
    guard(async (reqid, buffer: Buffer, offset: number, data: Buffer) => {
      const handle = handles.get(handleId(buffer));
      if (handle?.kind !== 'file') throw Object.assign(new Error('bad handle'), { code: 'EBADF' });
      await handle.fd.write(data, 0, data.length, offset);
      ok(reqid);
    }),
  );
  sftp.on(
    'CLOSE',
    guard(async (reqid, buffer: Buffer) => {
      const id = handleId(buffer);
      const handle = handles.get(id);
      handles.delete(id);
      if (handle?.kind === 'file') await handle.fd.close();
      ok(reqid);
    }),
  );
  sftp.on(
    'OPENDIR',
    guard(async (reqid, target: string) => {
      const dir = local(target);
      if (!(await fs.stat(dir)).isDirectory()) {
        throw Object.assign(new Error('not a dir'), { code: 'ENOTDIR' });
      }
      sftp.handle(reqid, allocate({ kind: 'dir', dir, done: false }));
    }),
  );
  sftp.on(
    'READDIR',
    guard(async (reqid, buffer: Buffer) => {
      const handle = handles.get(handleId(buffer));
      if (handle?.kind !== 'dir') throw Object.assign(new Error('bad handle'), { code: 'EBADF' });
      if (handle.done) {
        sftp.status(reqid, STATUS_CODE.EOF);
        return;
      }
      handle.done = true;
      const entries: Dirent[] = await fs.readdir(handle.dir, { withFileTypes: true });
      const names = await Promise.all(
        entries.map(async (entry) => {
          const stats = await fs.lstat(path.join(handle.dir, entry.name));
          return {
            filename: entry.name,
            longname: longname(entry.name, stats),
            attrs: toAttrs(stats),
          };
        }),
      );
      sftp.name(reqid, [
        { filename: '.', longname: '.', attrs: toAttrs(await fs.stat(handle.dir)) },
        ...names,
      ]);
    }),
  );
  sftp.on(
    'MKDIR',
    guard(async (reqid, target: string, attrs: { mode?: number }) => {
      await fs.mkdir(local(target), { mode: attrs.mode ?? 0o755 });
      ok(reqid);
    }),
  );
  sftp.on(
    'RMDIR',
    guard(async (reqid, target: string) => {
      await fs.rmdir(local(target));
      ok(reqid);
    }),
  );
  sftp.on(
    'REMOVE',
    guard(async (reqid, target: string) => {
      await fs.unlink(local(target));
      ok(reqid);
    }),
  );
  sftp.on(
    'RENAME',
    guard(async (reqid, from: string, to: string) => {
      const exists = await fs.lstat(local(to)).then(
        () => true,
        () => false,
      );
      if (exists) {
        sftp.status(reqid, STATUS_CODE.FAILURE, 'Target exists');
        return;
      }
      await fs.rename(local(from), local(to));
      ok(reqid);
    }),
  );
  for (const event of ['SETSTAT', 'FSETSTAT'] as const) {
    sftp.on(
      event,
      guard(
        async (
          reqid,
          target: string | Buffer,
          attrs: { mode?: number; mtime?: number; atime?: number },
        ) => {
          let file: string;
          if (typeof target === 'string') {
            file = local(target);
          } else {
            const handle = handles.get(handleId(target));
            if (handle?.kind !== 'file') throw Object.assign(new Error('bad'), { code: 'EBADF' });
            if (attrs.mode !== undefined) await handle.fd.chmod(attrs.mode & 0o7777);
            if (attrs.mtime !== undefined)
              await handle.fd.utimes(attrs.atime ?? attrs.mtime, attrs.mtime);
            ok(reqid);
            return;
          }
          if (attrs.mode !== undefined) await fs.chmod(file, attrs.mode & 0o7777);
          if (attrs.mtime !== undefined)
            await fs.utimes(file, attrs.atime ?? attrs.mtime, attrs.mtime);
          ok(reqid);
        },
      ),
    );
  }
  sftp.on(
    'READLINK',
    guard(async (reqid, target: string) => {
      const link = await fs.readlink(local(target));
      sftp.name(reqid, [{ filename: link, longname: link, attrs: {} as never }]);
    }),
  );
  sftp.on('close', () => {
    for (const handle of handles.values()) {
      if (handle.kind === 'file') void handle.fd.close().catch(() => undefined);
    }
    handles.clear();
  });
}

function acceptsKey(ctx: PublicKeyAuthContext, publicKey: string | undefined): boolean {
  if (!publicKey) return false;
  const allowed = utils.parseKey(publicKey);
  if (allowed instanceof Error || Array.isArray(allowed)) return false;
  if (ctx.key.algo !== allowed.type || !ctx.key.data.equals(allowed.getPublicSSH())) return false;
  return !ctx.signature || allowed.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo);
}

function authenticate(ctx: AuthContext, users: TestUser[], log: string[]): void {
  log.push(ctx.method);
  const user = users.find((entry) => entry.username === ctx.username);
  const methods: AuthContext['method'][] = [];
  if (user?.publicKey) methods.push('publickey');
  if (user?.password && !user.keyboardInteractive) methods.push('password');
  if (user?.keyboardInteractive) methods.push('keyboard-interactive');
  const verdict = (accepted: boolean) => {
    if (accepted) ctx.accept();
    else ctx.reject(methods as never);
  };

  if (!user) {
    verdict(false);
    return;
  }
  switch (ctx.method) {
    case 'password':
      verdict(!user.keyboardInteractive && ctx.password === user.password);
      break;
    case 'keyboard-interactive':
      if (user.keyboardInteractive) {
        ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) =>
          verdict(answers[0] === user.password),
        );
      } else {
        verdict(false);
      }
      break;
    case 'publickey':
      verdict(acceptsKey(ctx, user.publicKey));
      break;
    default:
      verdict(false);
  }
}

export async function startTestServer(options: TestServerOptions): Promise<TestServer> {
  const home = options.home ?? '/home/test';
  await fs.mkdir(path.join(options.root, ...home.split('/').filter(Boolean)), { recursive: true });
  const pair = generateKey();
  const hostKey = pair.parsed;
  const clients = new Set<Connection>();
  const state = { connections: 0, authAttempts: [] as string[], commands: [] as string[] };

  const server = new Server({ hostKeys: [pair.private] }, (client) => {
    state.connections++;
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (ctx) => authenticate(ctx, options.users, state.authAttempts));
    client.on('tcpip', (accept, reject, info) => {
      if (!options.allowForwarding) return reject();
      const socket = net.connect(info.destPort, info.destIP, () => {
        const channel = accept();
        channel.pipe(socket).pipe(channel);
      });
      socket.on('error', () => reject());
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => serveSftp(acceptSftp(), options.root, home));
        session.on('exec', (accept, reject, info) => {
          state.commands.push(info.command);
          if (!options.supportsExec) {
            reject?.();
            return;
          }
          const channel = accept();
          const child = spawn('/bin/sh', ['-c', info.command], { cwd: options.root });
          child.stdout.pipe(channel, { end: false });
          child.stderr.pipe(channel.stderr, { end: false });
          channel.on('close', () => child.kill());
          child.on('close', (code) => {
            channel.exit(code ?? 1);
            channel.end();
          });
        });
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    hostKey,
    get connections() {
      return state.connections;
    },
    authAttempts: state.authAttempts,
    commands: state.commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of clients) client.end();
        server.close(() => resolve());
      }),
  };
}
