import { commitment, contentHash } from '../../crypto/src/index.js';
import type { CommitmentKind } from '../../crypto/src/index.js';
import type { Hash } from '../../domain/src/protocol.js';
import { ContentError } from './errors.js';
import type { ContentStore } from './store.js';

/** Content kinds that can be revealed (spec section 6): the three salted kinds plus the unsalted precheck report. */
export type RevealKind = CommitmentKind | 'precheck-report';
const SALT_HEX = /^[0-9a-f]{64}$/;

/** Commitment for a salted kind (delegates to the protocol's `commitment`). */
export function commitTo(kind: CommitmentKind, salt32: Uint8Array, bytes: Uint8Array): Hash {
  return commitment(kind, salt32, bytes);
}
/** Verify bytes against a commitment. `saltHex` is the empty string exactly for `precheck-report`, whose commitment is the plain content hash. */
export function verifyReveal(kind: RevealKind, commitmentHash: Hash, bytes: Uint8Array, saltHex: string): boolean {
  if (kind === 'precheck-report') return saltHex === '' && contentHash(bytes) === commitmentHash;
  if (!SALT_HEX.test(saltHex)) return false;
  return commitment(kind, Buffer.from(saltHex, 'hex'), bytes) === commitmentHash;
}
export interface RevealWindow { opensAtMs: number; closesAtMs: number }
export function revealWindow(opensAtMs: number, closesAtMs: number): RevealWindow {
  if (!Number.isSafeInteger(opensAtMs) || !Number.isSafeInteger(closesAtMs) || closesAtMs < opensAtMs) throw new ContentError('BAD_INPUT', 'closesAt must not precede opensAt');
  return { opensAtMs, closesAtMs };
}
export const isRevealOpen = (window: RevealWindow, nowMs: number): boolean => nowMs >= window.opensAtMs && nowMs <= window.closesAtMs;

export interface EvidenceRevealedDraft { kind: RevealKind; by?: never; salt: string; contentHash: Hash }
/**
 * Verify first, store second: the window and the commitment are checked before any byte is stored, so a bad reveal
 * leaves the store untouched. The result carries the `kind` and `salt` fields of an EvidenceRevealed payload.
 */
export async function revealAndStore(store: ContentStore, input: { kind: RevealKind; commitment: Hash; bytes: Uint8Array; saltHex: string; window: RevealWindow; nowMs: number }): Promise<EvidenceRevealedDraft> {
  if (!isRevealOpen(input.window, input.nowMs)) throw new ContentError('REVEAL_WINDOW', `${input.window.opensAtMs}..${input.window.closesAtMs}`);
  if (input.kind !== 'precheck-report' && !SALT_HEX.test(input.saltHex)) throw new ContentError('BAD_SALT');
  if (!verifyReveal(input.kind, input.commitment, input.bytes, input.saltHex)) throw new ContentError('COMMITMENT_MISMATCH');
  return { kind: input.kind, salt: input.saltHex, contentHash: await store.put(input.bytes) };
}
