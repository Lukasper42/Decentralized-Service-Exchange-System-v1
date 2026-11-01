import type { CryptoPort, StoragePort } from './ports.js';
import type { ApiError, LedgerEntry } from './types.js';
import { receiptHash } from './crypto.js';
import { isRecord } from './guards.js';

export const PIN_STORAGE_KEY = 'skillx.pin.v1';

export interface Pin {
  relayPubkey: string;
  length: number;
  receiptHash: string;
}

export function loadPin(storage: StoragePort): Pin | null {
  const raw = storage.get(PIN_STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  try {
    const p: unknown = JSON.parse(raw);
    if (
      isRecord(p) &&
      typeof p['relayPubkey'] === 'string' &&
      typeof p['receiptHash'] === 'string' &&
      typeof p['length'] === 'number' &&
      Number.isSafeInteger(p['length']) &&
      p['length'] > 0
    ) {
      return { relayPubkey: p['relayPubkey'], length: p['length'], receiptHash: p['receiptHash'] };
    }
  } catch {
    /* invalid: treat as no pin */
  }
  return null;
}

export function clearPin(storage: StoragePort): void {
  storage.remove(PIN_STORAGE_KEY);
}

function divergence(message: string): ApiError {
  return { code: 'DIVERGENCE', message, path: '$.sync.pin' };
}

/**
 * Detects rollback/fork of the relay compared to the last seen, verified state
 * (pinned in local storage) and updates the pin on progress.
 */
export async function checkAndUpdatePin(
  crypto: CryptoPort,
  storage: StoragePort,
  relayPubkey: string,
  entries: readonly LedgerEntry[],
): Promise<ApiError | null> {
  const pin = loadPin(storage);
  if (pin !== null && pin.relayPubkey === relayPubkey) {
    if (entries.length < pin.length) {
      return divergence('Relay shows an older state than last seen (rollback?)');
    }
    const pinned = entries[pin.length - 1];
    if (!pinned || (await receiptHash(crypto, pinned.receipt)) !== pin.receiptHash) {
      return divergence('Chain differs from the last seen state (fork?)');
    }
  }
  const last = entries[entries.length - 1];
  if (last && (pin === null || pin.relayPubkey !== relayPubkey || entries.length > pin.length)) {
    const next: Pin = {
      relayPubkey,
      length: entries.length,
      receiptHash: await receiptHash(crypto, last.receipt),
    };
    storage.set(PIN_STORAGE_KEY, JSON.stringify(next));
  }
  return null;
}
