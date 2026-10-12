import { type ParsedKey, utils } from 'ssh2';

export interface TestKeyPair {
  private: string;
  public: string;
  parsed: ParsedKey;
}

export function generateKey(
  type: 'ed25519' | 'ecdsa' = 'ed25519',
  options: { passphrase?: string; cipher?: string; rounds?: number } = {},
): TestKeyPair {
  for (let attempt = 0; attempt < 20; attempt++) {
    const pair =
      type === 'ecdsa'
        ? utils.generateKeyPairSync('ecdsa', { bits: 256, ...options } as never)
        : utils.generateKeyPairSync('ed25519', options as never);
    const parsed = utils.parseKey(pair.private, options.passphrase);
    if (!(parsed instanceof Error) && !Array.isArray(parsed)) {
      return { private: pair.private, public: pair.public, parsed };
    }
  }
  throw new Error('Could not generate a usable test key');
}
