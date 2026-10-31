// apps/relay/key-file.ts
import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeySource } from '../../packages/relay/src/ports.js';

export interface KeyFilePort {
  statMode(path: string): number;
  readText(path: string): string;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export function loadRelayKeySource(options: {
  path: string;
  files: KeyFilePort;
  expectedKeyId: string;
  expectedPublicKey: string;
  platform: string;
}): KeySource {
  if (options.platform !== 'win32') {
    const mode = options.files.statMode(options.path);
    if ((mode & 0o077) !== 0) {
      throw new Error('relay key file must not be accessible by group or others');
    }
  }

  const text = options.files.readText(options.path).trim();
  if (text.length === 0 || !BASE64_PATTERN.test(text)) {
    throw new Error('relay key file is not base64');
  }

  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({
      key: Buffer.from(text, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  } catch {
    throw new Error('relay key file is not a valid private key');
  }

  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('relay key must be ed25519');
  }

  const publicKey = createPublicKey(privateKey);
  const derivedPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  if (derivedPublicKey !== options.expectedPublicKey) {
    throw new Error('relay key file does not match the genesis relay key');
  }

  return {
    privateKeyFor(keyId: string): string | null {
      return keyId === options.expectedKeyId ? text : null;
    },
  };
}
