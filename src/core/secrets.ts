import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { appFile } from './paths.js';
import { JsonStore, readText, writeFileAtomic } from './store.js';

export type SecretKind = 'password' | 'passphrase';

export interface SecretBackend {
  readonly name: 'keychain' | 'file';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const SERVICE = 'easyscp';

interface KeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}

type KeyringModule = { AsyncEntry: new (service: string, account: string) => KeyringEntry };

class KeychainBackend implements SecretBackend {
  readonly name = 'keychain';

  constructor(private readonly keyring: KeyringModule) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.entry(key).getPassword()) ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    await this.entry(key).setPassword(value);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.entry(key).deletePassword();
    } catch {}
  }

  private entry(key: string): KeyringEntry {
    return new this.keyring.AsyncEntry(SERVICE, key);
  }
}

interface SealedSecret {
  iv: string;
  tag: string;
  data: string;
}

interface VaultFile {
  version: 1;
  secrets: Record<string, SealedSecret>;
}

class FileBackend implements SecretBackend {
  readonly name = 'file';
  private key: Promise<Buffer> | undefined;
  private readonly vault = new JsonStore<VaultFile>({
    file: () => appFile('vault.json'),
    defaults: () => ({ version: 1, secrets: {} }),
    normalize: (raw) => {
      const secrets = (raw as VaultFile | undefined)?.secrets;
      return { version: 1, secrets: secrets && typeof secrets === 'object' ? secrets : {} };
    },
  });

  async get(key: string): Promise<string | undefined> {
    const sealed = (await this.vault.read()).secrets[key];
    if (!sealed) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', await this.masterKey(), b64(sealed.iv));
      decipher.setAAD(Buffer.from(key));
      decipher.setAuthTag(b64(sealed.tag));
      return Buffer.concat([decipher.update(b64(sealed.data)), decipher.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.masterKey(), iv);
    cipher.setAAD(Buffer.from(key));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const sealed: SealedSecret = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    await this.vault.update((file) => {
      file.secrets[key] = sealed;
      return file;
    });
  }

  async delete(key: string): Promise<void> {
    await this.vault.update((file) => {
      delete file.secrets[key];
      return file;
    });
  }

  private masterKey(): Promise<Buffer> {
    this.key ??= this.loadKey();
    return this.key;
  }

  private async loadKey(): Promise<Buffer> {
    const file = appFile('vault.key');
    const existing = (await readText(file))?.trim();
    if (existing && b64(existing).length === 32) return b64(existing);
    const fresh = randomBytes(32);
    await writeFileAtomic(file, fresh.toString('base64'));
    return fresh;
  }
}

function b64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

async function loadKeychain(): Promise<SecretBackend | undefined> {
  if (process.env.EASYSCP_SECRETS === 'file') return undefined;
  try {
    const keyring = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
    const backend = new KeychainBackend(keyring);
    await backend.get('__probe__');
    return backend;
  } catch {
    return undefined;
  }
}

let backendPromise: Promise<SecretBackend> | undefined;

export function secretBackend(): Promise<SecretBackend> {
  backendPromise ??= loadKeychain().then((keychain) => keychain ?? new FileBackend());
  return backendPromise;
}

function secretKey(hostId: string, kind: SecretKind): string {
  return `${hostId}:${kind}`;
}

export async function getSecret(hostId: string, kind: SecretKind): Promise<string | undefined> {
  try {
    return await (await secretBackend()).get(secretKey(hostId, kind));
  } catch {
    return undefined;
  }
}

export async function setSecret(hostId: string, kind: SecretKind, value: string): Promise<void> {
  await (await secretBackend()).set(secretKey(hostId, kind), value);
}

export async function deleteSecret(hostId: string, kind: SecretKind): Promise<void> {
  try {
    await (await secretBackend()).delete(secretKey(hostId, kind));
  } catch {}
}

export async function deleteHostSecrets(hostId: string): Promise<void> {
  await Promise.all([deleteSecret(hostId, 'password'), deleteSecret(hostId, 'passphrase')]);
}
