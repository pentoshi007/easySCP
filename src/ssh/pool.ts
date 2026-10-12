import type { Host } from '../core/hosts.js';
import type { ConnectOptions } from './connect.js';
import { Session } from './session.js';

export class SessionPool {
  private readonly sessions = new Map<string, Promise<Session>>();

  constructor(private readonly options: ConnectOptions) {}

  async get(host: Host): Promise<Session> {
    const cached = this.sessions.get(host.id);
    if (cached) {
      const session = await cached.catch(() => undefined);
      if (session && !session.closed) return session;
    }
    return this.open(host);
  }

  closeAll(): void {
    for (const pending of this.sessions.values()) {
      pending.then((session) => session.close()).catch(() => undefined);
    }
    this.sessions.clear();
  }

  drop(hostId: string): void {
    const pending = this.sessions.get(hostId);
    this.sessions.delete(hostId);
    pending?.then((session) => session.close()).catch(() => undefined);
  }

  private open(host: Host): Promise<Session> {
    const pending = Session.open(host, this.options);
    this.sessions.set(host.id, pending);
    pending.then(
      (session) => session.onClose(() => this.forget(host.id, pending)),
      () => this.forget(host.id, pending),
    );
    return pending;
  }

  private forget(hostId: string, pending: Promise<Session>): void {
    if (this.sessions.get(hostId) === pending) this.sessions.delete(hostId);
  }
}
