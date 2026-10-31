import { webcrypto } from 'node:crypto';
import { b64Decode } from './b64.js';
import { sigMsg } from './canonical.js';
import type { JsonObject } from './canonical.js';
import type { ClockPort } from './ports.js';
import { keyBundleBody, mailboxIdOf, parseAuthHeader } from './protocol.js';
import type { AuthHeader, KeyBundle } from './protocol.js';

const subtle = webcrypto.subtle;

async function verifySignature(
  pubkeyB64: string,
  message: Uint8Array<ArrayBuffer>,
  sigB64: string,
): Promise<boolean> {
  try {
    const key = await subtle.importKey(
      'spki',
      b64Decode(pubkeyB64),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await subtle.verify({ name: 'Ed25519' }, key, b64Decode(sigB64), message);
  } catch {
    return false;
  }
}

export async function verifyKeyBundle(bundle: KeyBundle): Promise<boolean> {
  return verifySignature(
    bundle.identity_pubkey,
    sigMsg('skillx/v1/mailbox-key\n', keyBundleBody(bundle)),
    bundle.sig,
  );
}

export async function verifyAuthHeader(
  header: string,
  method: 'GET' | 'DELETE',
  path: string,
  mailboxId: string,
  clock: ClockPort,
): Promise<boolean> {
  let parsed: AuthHeader | null;
  try {
    parsed = parseAuthHeader(header);
  } catch {
    return false;
  }
  const nowSec = Math.floor(clock.nowMs() / 1000);
  if (Math.abs(nowSec - parsed.ts) > 120) {
    return false;
  }
  let derived: string;
  try {
    derived = mailboxIdOf(parsed.pubkey);
  } catch {
    return false;
  }
  if (derived !== mailboxId) {
    return false;
  }
  const body: JsonObject = { method, path, ts: parsed.ts };
  return verifySignature(
    parsed.pubkey,
    sigMsg('skillx/v1/mailbox-auth\n', body),
    parsed.sig,
  );
}
