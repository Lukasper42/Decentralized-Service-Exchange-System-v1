import { randomBytes, webcrypto } from 'node:crypto';
import type { Server } from 'node:http';
import { b64Encode } from '../b64.js';
import { sigMsg } from '../canonical.js';
import type { JsonObject } from '../canonical.js';
import type { ClockPort, RandomPort, StoreFilePort } from '../ports.js';
import { mailboxIdOf } from '../protocol.js';
import type { Envelope, KeyBundle } from '../protocol.js';
import { createMailboxServer } from '../server.js';
import type { HandlerDeps } from '../server.js';

const subtle = webcrypto.subtle;

export interface Signer {
  readonly pubkeyB64: string;
  sign(message: Uint8Array<ArrayBuffer>): Promise<string>;
}

export async function makeSigner(): Promise<Signer> {
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as webcrypto.CryptoKeyPair;
  const spki = await subtle.exportKey('spki', pair.publicKey);
  const privateKey = pair.privateKey;
  return {
    pubkeyB64: b64Encode(new Uint8Array(spki)),
    sign: async (message: Uint8Array<ArrayBuffer>): Promise<string> => {
      const signature = await subtle.sign({ name: 'Ed25519' }, privateKey, message);
      return b64Encode(new Uint8Array(signature));
    },
  };
}

export function identityOf(signer: Signer): string {
  return mailboxIdOf(signer.pubkeyB64);
}

export async function makeBundle(
  signer: Signer,
  createdAt: string,
  xPubkey?: string,
): Promise<KeyBundle> {
  const xPubkeyValue = xPubkey ?? b64Encode(new Uint8Array(randomBytes(32)));
  const body: JsonObject = {
    v: 1,
    identity_pubkey: signer.pubkeyB64,
    x_pubkey: xPubkeyValue,
    created_at: createdAt,
  };
  const sig = await signer.sign(sigMsg('skillx/v1/mailbox-key\n', body));
  return {
    v: 1,
    identity_pubkey: signer.pubkeyB64,
    x_pubkey: xPubkeyValue,
    created_at: createdAt,
    sig,
  };
}

export function makeEnvelope(): Envelope {
  return {
    v: 1,
    eph_pub: b64Encode(new Uint8Array(randomBytes(32))),
    iv: b64Encode(new Uint8Array(randomBytes(12))),
    ct: b64Encode(new Uint8Array(randomBytes(1024))),
  };
}

export async function makeAuth(
  signer: Signer,
  method: 'GET' | 'DELETE',
  path: string,
  ts: number,
): Promise<string> {
  const body: JsonObject = { method, path, ts };
  const sig = await signer.sign(sigMsg('skillx/v1/mailbox-auth\n', body));
  return `${signer.pubkeyB64}.${String(ts)}.${sig}`;
}

export class FakeClock implements ClockPort {
  private ms: number;

  constructor(ms: number) {
    this.ms = ms;
  }

  nowMs(): number {
    return this.ms;
  }

  nowIso(): string {
    return new Date(this.ms).toISOString();
  }

  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

export const testRandom: RandomPort = {
  bytes: (n: number): Uint8Array => new Uint8Array(randomBytes(n)),
};

export class MemoryFile implements StoreFilePort {
  content: string | null = null;

  async read(): Promise<string | null> {
    return this.content;
  }

  async write(text: string): Promise<void> {
    this.content = text;
  }
}

export interface TestServer {
  readonly base: string;
  close(): Promise<void>;
}

export async function startServer(deps: HandlerDeps): Promise<TestServer> {
  const server: Server = createMailboxServer(deps);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server has no address');
  }
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
        server.closeAllConnections();
      }),
  };
}

export function readStringField(body: unknown, field: string): string {
  if (typeof body !== 'object' || body === null) {
    throw new Error('body is not an object');
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string') {
    throw new Error('field is not a string');
  }
  return value;
}
