import type { ApiError, ErrorCode } from './types.js';

export function formatAmount(n: number | 'overflow'): string {
  if (n === 'overflow') {
    return 'overflow';
  }
  const neg = n < 0;
  const abs = Math.abs(n);
  const s = String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + s + ' units';
}

export function formatIso(iso: string): string {
  // Fixed-width ISO string -> convert directly into readable form.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(iso);
  if (!m) {
    return iso;
  }
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${s} UTC`;
}

export function shortPubkey(pubkey: string): string {
  if (pubkey.length <= 16) {
    return pubkey;
  }
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
}

export function shortHash(hash: string): string {
  if (hash.length <= 16) {
    return hash;
  }
  return `${hash.slice(0, 10)}…${hash.slice(-10)}`;
}

export function formatError(e: ApiError): string {
  return `[${e.code}] ${e.message} (${e.path})`;
}

export function asErrorCode(s: string): ErrorCode {
  const known: readonly ErrorCode[] = [
    'VERSION',
    'ENVELOPE',
    'TIMESTAMP',
    'PAYLOAD',
    'SIGNATURE',
    'UNKNOWN_TYPE',
    'UNKNOWN_FIELD',
    'MISSING_FIELD',
    'FIELD_FORMAT',
    'AMOUNT',
    'LIMIT',
    'SIGNER_AUTHORITY',
    'ATTESTATION',
    'CHAIN_LINK',
    'FORK',
    'RECEIPT_SEQUENCE',
    'RECEIPT_EVENT_HASH',
    'RECEIPT_LINK',
    'RECEIPT_SIGNATURE',
    'KEY_UNKNOWN',
    'STATE',
    'WINDOW',
    'POLICY',
    'REPLAY',
    'DUPLICATE',
    'INSUFFICIENT_FUNDS',
    'JURY_MISMATCH',
    'READ_ONLY',
    'RATE_LIMITED',
    'NOT_FOUND',
    'BAD_REQUEST',
    'TOO_LARGE',
    'STORE_FAILURE',
    'TRANSPORT',
    'DIVERGENCE',
    'SIGNING',
  ];
  for (const k of known) {
    if (k === s) {
      return k;
    }
  }
  return 'BAD_REQUEST';
}

export function bundleLookupMessage(code: string): string {
  if (code === 'NOT_FOUND') {
    return 'Recipient has not published a key bundle yet (or the mailbox URL is a different one).';
  }
  return `Recipient key: ${code}`;
}
