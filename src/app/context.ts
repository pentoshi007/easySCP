import type { ParsedArgs } from '../cli/args.js';
import type { Host } from '../core/hosts.js';
import { RemoteFileSystem } from '../fs/remote.js';
import { SessionPool } from '../ssh/pool.js';
import type { Session } from '../ssh/session.js';
import type { Ui } from '../ui/ui.js';
import { UiInteraction } from './interaction.js';

export interface Context {
  ui: Ui;
  args: ParsedArgs;
  connect(host: Host): Promise<RemoteFileSystem>;
  forget(host: Host): void;
  close(): void;
}

export function createContext(ui: Ui, args: ParsedArgs): Context {
  const interaction = new UiInteraction(ui, { acceptNewHostKeys: args.yes });
  const pool = new SessionPool({ interaction, signal: ui.signal });
  const filesystems = new WeakMap<Session, RemoteFileSystem>();

  return {
    ui,
    args,
    async connect(host) {
      interaction.begin(`Connecting to ${host.name}`);
      let session: Session;
      try {
        session = await pool.get(host);
      } finally {
        interaction.end();
      }
      let fs = filesystems.get(session);
      if (!fs) {
        fs = new RemoteFileSystem(session);
        filesystems.set(session, fs);
      }
      return fs;
    },
    forget(host) {
      pool.drop(host.id);
    },
    close() {
      pool.closeAll();
    },
  };
}
