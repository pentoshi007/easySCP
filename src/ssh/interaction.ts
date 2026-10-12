import type { Host } from '../core/hosts.js';
import type { HostKeyInfo } from './knownHosts.js';

export interface HostKeyQuestion {
  host: Host;
  address: string;
  key: HostKeyInfo;
  status: 'unknown' | 'changed';
  knownTypes: string[];
}

export interface SecretQuestion {
  host: Host;
  kind: 'password' | 'passphrase' | 'challenge';
  message: string;
  instructions?: string;
  retry: boolean;
  echo: boolean;
}

export interface Interaction {
  confirmHostKey(question: HostKeyQuestion): Promise<boolean>;
  askSecret(question: SecretQuestion): Promise<string | undefined>;
  status(message: string): void;
}

export function nonInteractive(options: { acceptNewHostKeys?: boolean } = {}): Interaction {
  return {
    confirmHostKey: async (question) =>
      question.status === 'unknown' && !!options.acceptNewHostKeys,
    askSecret: async () => undefined,
    status: () => {},
  };
}
