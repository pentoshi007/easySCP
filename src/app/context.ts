import type { ParsedArgs } from '../cli/args.js';
import type { Host } from '../core/hosts.js';
import { RemoteFileSystem } from '../fs/remote.js';
import { SessionPool } from '../ssh/pool.js';
import type { Session } from '../ssh/session.js';
import type { Ui } from '../ui/ui.js';
import { joinNames } from '../util/format.js';
import { UiInteraction } from './interaction.js';

export interface Context {
  ui: Ui;
  args: ParsedArgs;
  connect(host: Host): Promise<RemoteFileSystem>;
  connectAll(hosts: Host[]): Promise<PromiseSettledResult<RemoteFileSystem>[]>;
  forget(host: Host): void;
  close(): void;
}

export function createContext(ui: Ui, args: ParsedArgs): Context {
  const interaction = new UiInteraction(ui, { acceptNewHostKeys: args.yes });
  const pool = new SessionPool({ interaction, signal: ui.signal });
  const filesystems = new WeakMap<Session, RemoteFileSystem>();
  const filesystem = (session: Session) => {
    let fs = filesystems.get(session);
    if (!fs) {
      fs = new RemoteFileSystem(session);
      filesystems.set(session, fs);
    }
    return fs;
  };

  return {
    ui,
    args,
    async connect(host) {
      interaction.begin(`Connecting to ${host.name}`);
      try {
        return filesystem(await pool.get(host));
      } finally {
        interaction.end();
      }
    },
    async connectAll(hosts) {
      const names = joinNames(hosts.map((host) => host.name));
      interaction.begin(`Connecting to ${names}`, { fixed: hosts.length > 1 });
      try {
        return await Promise.allSettled(
          hosts.map(async (host) => filesystem(await pool.get(host))),
        );
      } finally {
        interaction.end();
      }
    },
    forget(host) {
      pool.drop(host.id);
    },
    close() {
      pool.closeAll();
    },
  };
}
