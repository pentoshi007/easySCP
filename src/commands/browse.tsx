import type { Context } from '../app/context.js';
import { chooseHost } from '../app/hostPicker.js';
import { type CopyRecord, Explorer, type ExplorerExit, type Side } from '../browser/Explorer.js';
import { AppError } from '../core/errors.js';
import { type Host, hostLabel } from '../core/hosts.js';
import { rememberLocalDir, rememberRemoteDir } from '../core/state.js';
import { localFs } from '../fs/local.js';
import { recordTransfer } from '../transfer/history.js';
import { formatBytes, plural } from '../util/format.js';
import { addHost } from './add.js';
import { done, type Outcome } from './outcome.js';
import { remoteStart } from './places.js';

async function localStart(host: Host): Promise<string> {
  if (host.localDir && (await localFs.stat(host.localDir))?.kind === 'dir') return host.localDir;
  return process.cwd();
}

export async function browseHost(ctx: Context, host: Host): Promise<Outcome | undefined> {
  const { ui } = ctx;
  if (!ui.interactive) {
    throw new AppError(
      'The browser needs an interactive terminal',
      'Use `easyscp send` or `easyscp receive` in scripts.',
    );
  }

  let remote = await ctx.connect(host);
  let dirs: [string, string] = [await localStart(host), (await remoteStart(remote, host)).start];
  let active: Side = 0;
  let files = 0;
  let bytes = 0;

  const record = async ({ direction, sources, destination, result }: CopyRecord) => {
    await recordTransfer({
      direction,
      hostId: host.id,
      hostName: host.name,
      sources,
      destination,
      files: result.files,
      bytes: result.bytes,
      durationMs: Math.round(result.durationMs),
      status: result.status,
      ...(result.error ? { error: result.error.message } : {}),
    });
    if (result.files === 0) return;
    if (direction === 'upload') await rememberRemoteDir(host.id, destination);
    else await rememberLocalDir(destination);
  };

  for (;;) {
    const session = remote.session;
    const exit = await ui.fullscreen<ExplorerExit>((finish) => (
      <Explorer
        title={host.name}
        subtitle={hostLabel(host)}
        sides={[
          { fs: localFs, label: 'local', dir: dirs[0] },
          {
            fs: remote,
            label: host.name,
            dir: dirs[1],
            onClose: (listener) => session.onClose(listener),
          },
        ]}
        initialActive={active}
        onInterrupt={(handler) => ui.onInterrupt(handler)}
        onCopy={record}
        onExit={finish}
      />
    ));
    dirs = exit.dirs;
    active = exit.active;
    files += exit.files;
    bytes += exit.bytes;
    if (exit.reason !== 'reconnect') break;
    ctx.forget(host);
    remote = await ctx.connect(host);
  }

  await rememberRemoteDir(host.id, dirs[1]).catch(() => undefined);
  if (files === 0) return undefined;
  return done(`Copied ${plural(files, 'file')}`, formatBytes(bytes));
}

export async function browseCommand(ctx: Context): Promise<Outcome | undefined> {
  const [name] = ctx.args.positionals;
  const host = await chooseHost(ctx, {
    title: 'Browse which machine?',
    name,
    onAdd: () => addHost(ctx),
  });
  return (await browseHost(ctx, host)) ?? done(`Finished browsing ${host.name}`);
}
