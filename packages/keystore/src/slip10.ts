import { createHmac } from 'node:crypto';
import { KeystoreError } from './errors.js';
import { u32be, wipe } from './bytes.js';

const CURVE_KEY = Buffer.from('ed25519 seed', 'utf8');
const HARDENED = 0x80000000;
/** Purpose constant 0x4B53 ("KS"). Paths are fixed in docs/keystore-spec.md. */
export const PURPOSE = 19283;
export const PATH_ACCOUNT = "m/19283'/0'/0'";
export const PATH_RECOVERY = "m/19283'/0'/1'";

export interface Slip10Node { key: Buffer; chainCode: Buffer }

export function parsePath(path: string): number[] {
  const parts = path.split('/');
  if (parts[0] !== 'm' || parts.length < 2) throw new KeystoreError('E_BAD_INPUT', 'path must start with "m/"');
  return parts.slice(1).map((segment) => {
    if (!/^\d+'$/.test(segment)) throw new KeystoreError('E_BAD_INPUT', 'Ed25519 SLIP-0010 requires hardened segments');
    const n = Number.parseInt(segment.slice(0, -1), 10);
    if (!Number.isSafeInteger(n) || n >= HARDENED) throw new KeystoreError('E_BAD_INPUT', 'index out of range');
    return n + HARDENED;
  });
}

function split(digest: Buffer): Slip10Node {
  const node = { key: Buffer.from(digest.subarray(0, 32)), chainCode: Buffer.from(digest.subarray(32, 64)) };
  wipe(digest);
  return node;
}
export function masterNode(seed: Uint8Array): Slip10Node {
  if (seed.length < 16) throw new KeystoreError('E_BAD_INPUT', 'seed must be at least 16 bytes');
  return split(createHmac('sha512', CURVE_KEY).update(seed).digest());
}
export function childNode(node: Slip10Node, index: number): Slip10Node {
  if (index < HARDENED) throw new KeystoreError('E_BAD_INPUT', 'non-hardened index');
  const data = Buffer.concat([Buffer.from([0]), node.key, u32be(index)]);
  const child = split(createHmac('sha512', node.chainCode).update(data).digest());
  wipe(data);
  return child;
}
/** Derive the node at `path`; the caller must wipe the returned buffers. */
export function derivePath(seed: Uint8Array, path: string): Slip10Node {
  let node = masterNode(seed);
  for (const index of parsePath(path)) {
    const next = childNode(node, index);
    wipe(node.key, node.chainCode);
    node = next;
  }
  return node;
}
