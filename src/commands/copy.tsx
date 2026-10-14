import type { Context } from '../app/context.js';
import { chooseHost, hostChoice } from '../app/hostPicker.js';
import { AppError } from '../core/errors.js';
import { type Host, listHosts } from '../core/hosts.js';
import { expandPaths } from '../fs/glob.js';
import type { RemoteFileSystem } from '../fs/remote.js';
import type { ConflictPolicy } from '../transfer/run.js';
import { pickFiles } from '../ui/picker/pickers.js';
import { type CopyDestination, parseCopyTokens } from './copyArgs.js';
import { connectHosts, deliver, uniqueHosts } from './fanout.js';
import type { Outcome } from './outcome.js';
import { remoteStart } from './places.js';

export interface CopyFlowRequest {
  source?: Host;
  paths?: string[];
  destinations?: CopyDestination[];
  policy?: ConflictPolicy;
}

export async function copyCommand(ctx: Context): Promise<Outcome> {
  const request = parseCopyTokens(ctx.args.positionals, await listHosts());
  return copyFlow(ctx, {
    source: request.source,
    paths: request.paths,
    destinations: request.destinations.map((entry) => ({
      host: entry.host,
      dir: entry.dir ?? ctx.args.to,
    })),
  });
}

export async function copyFlow(ctx: Context, request: CopyFlowRequest): Promise<Outcome> {
  const { ui, args } = ctx;
  const hosts = await listHosts();
  if (hosts.length < 2) {
    throw new AppError(
      'Copying between machines needs at least two saved machines',
      'Save another one with `easyscp add`.',
    );
  }
  const source = request.source ?? (await chooseHost(ctx, { title: 'Copy from which machine?' }));
  const known = request.destinations ?? [];
  for (const entry of known) {
    if (entry.host.id === source.id) {
      throw new AppError(
        `${source.name} is the machine you are copying from`,
        'Choose other machines as destinations.',
      );
    }
  }

  let connections = await connectHosts(ctx, [source, ...uniqueHosts(known)]);
  if (connections.errors.has(source.id)) throw connections.errors.get(source.id);
  const sourceFs = connections.connected.get(source.id) as RemoteFileSystem;

  const paths = request.paths?.length
    ? await expandPaths(sourceFs, request.paths, sourceFs.home)
    : await pickFiles(ui, {
        fs: sourceFs,
        start: (await remoteStart(sourceFs, source)).start,
        title: `What do you want to copy from ${source.name}?`,
        action: 'copy',
      });

  let destinations = known;
  if (destinations.length === 0) {
    const others = hosts.filter((host) => host.id !== source.id);
    const picked = await ui.multiselect('Copy to which machines?', {
      choices: others.map(hostChoice),
      selected: others.length === 1 ? others : [],
      required: true,
    });
    destinations = picked.map((host) => ({ host, dir: args.to }));
    connections = await connectHosts(ctx, picked);
  }

  return deliver(ctx, {
    mode: 'copy',
    source,
    sourceFs,
    paths,
    destinations,
    connections,
    policy: request.policy,
  });
}
