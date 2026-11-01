import type { CryptoPort } from './ports.js';
import type {
  ApiError,
  Hash,
  LedgerEntry,
  Pubkey,
  SignedCheckpoint,
  SignedEvent,
} from './types.js';
import {
  eventHash,
  receiptHash,
  relayKeyId,
  sha256HexUtf8,
  verifyAttestation,
  verifyEvent,
  verifyReceiptWithKeyId,
} from './crypto.js';

export interface KeyRange {
  pubkey: Pubkey;
  keyId: Hash;
  validFrom: number;
  validTo: number | null;
}

export type VerifyResult = { ok: true } | { ok: false; error: ApiError };

function failure(code: ApiError['code'], message: string, path: string): VerifyResult {
  return { ok: false, error: { code, message, path } };
}

function compareIso(a: string, b: string): number {
  // Fixed width -> lexicographic order matches time order.
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export class ChainVerifier {
  private readonly port: CryptoPort;
  private readonly pinnedRelayPubkey: Pubkey;
  private ranges: KeyRange[];
  private entries: LedgerEntry[] = [];
  private lastReceiptHash: Hash | null = null;
  private signerTip: Map<Pubkey, Hash> = new Map();
  private brokenError: ApiError | null = null;

  constructor(port: CryptoPort, relayPubkey: Pubkey, initialKeyIds?: Hash[]) {
    this.port = port;
    this.pinnedRelayPubkey = relayPubkey;
    const keyId =
      initialKeyIds && initialKeyIds.length > 0 ? (initialKeyIds[0] as Hash) : '';
    this.ranges = [
      {
        pubkey: relayPubkey,
        keyId,
        validFrom: 1,
        validTo: null,
      },
    ];
  }

  get length(): number {
    return this.entries.length;
  }

  get isBroken(): boolean {
    return this.brokenError !== null;
  }

  get broken(): ApiError | null {
    return this.brokenError;
  }

  get keyRanges(): readonly KeyRange[] {
    return this.ranges;
  }

  getEntries(): readonly LedgerEntry[] {
    return this.entries;
  }

  /** Initializes keyId of the first range (async, since a hash is computed). */
  async init(): Promise<void> {
    const first = this.ranges[0];
    if (first) {
      first.keyId = await relayKeyId(this.port, first.pubkey);
    }
  }

  private rangeFor(sequence: number): KeyRange | null {
    for (const r of this.ranges) {
      if (sequence >= r.validFrom && (r.validTo === null || sequence <= r.validTo)) {
        return r;
      }
    }
    return null;
  }

  async append(entry: LedgerEntry): Promise<VerifyResult> {
    if (this.brokenError) {
      return { ok: false, error: this.brokenError };
    }
    const res = await this.appendInner(entry);
    if (!res.ok) {
      this.brokenError = res.error;
    }
    return res;
  }

  private async appendInner(entry: LedgerEntry): Promise<VerifyResult> {
    const { event, receipt } = entry;
    const p = '$';

    // 1. Sequence
    const expectedSeq = this.entries.length + 1;
    if (receipt.sequence !== expectedSeq) {
      return failure(
        'RECEIPT_SEQUENCE',
        `Expected sequence ${expectedSeq}, got ${receipt.sequence}`,
        `${p}.receipt.sequence`,
      );
    }

    // 2. Event signature
    let eventSigOk = false;
    try {
      eventSigOk = await verifyEvent(this.port, event);
    } catch {
      eventSigOk = false;
    }
    if (!eventSigOk) {
      return failure('SIGNATURE', 'Event signature is invalid', `${p}.event.signature`);
    }

    // 3. Event hash
    const eh = await eventHash(this.port, event);
    if (eh !== receipt.eventHash) {
      return failure(
        'RECEIPT_EVENT_HASH',
        'receipt.eventHash does not match the event',
        `${p}.receipt.eventHash`,
      );
    }

    // 4. Receipt linking
    if (receipt.previousReceiptHash !== this.lastReceiptHash) {
      return failure(
        'RECEIPT_LINK',
        'previousReceiptHash does not match the previous entry',
        `${p}.receipt.previousReceiptHash`,
      );
    }

    // 5. Key range + receipt signature
    const range = this.rangeFor(receipt.sequence);
    if (!range) {
      return failure(
        'KEY_UNKNOWN',
        `No key range covers sequence ${receipt.sequence}`,
        `${p}.receipt.keyId`,
      );
    }
    if (receipt.keyId !== range.keyId) {
      return failure(
        'KEY_UNKNOWN',
        'receipt.keyId does not match the valid key range',
        `${p}.receipt.keyId`,
      );
    }
    const receiptOk = await verifyReceiptWithKeyId(
      this.port,
      receipt,
      range.pubkey,
      range.keyId,
    );
    if (!receiptOk) {
      return failure(
        'RECEIPT_SIGNATURE',
        'Receipt signature is invalid for the relay key',
        `${p}.receipt.signature`,
      );
    }

    // 6. Per-signer chain
    const prevExpected = this.signerTip.get(event.signer) ?? null;
    if (event.prevHash !== prevExpected) {
      return failure(
        'CHAIN_LINK',
        'event.prevHash does not match the last event of this signer',
        `${p}.event.prevHash`,
      );
    }

    // 7. monotonic acceptedAt
    const lastEntry = this.entries[this.entries.length - 1];
    if (lastEntry) {
      if (compareIso(receipt.acceptedAt, lastEntry.receipt.acceptedAt) < 0) {
        return failure(
          'RECEIPT_SEQUENCE',
          'receipt.acceptedAt falls below the previous acceptedAt',
          `${p}.receipt.acceptedAt`,
        );
      }
    }

    // 8. Check relay key rotation before anything is accepted
    const rotation = await this.checkRotation(event);
    if (!rotation.ok) {
      return { ok: false, error: rotation.error };
    }

    // Everything verified: accept
    this.entries.push(entry);
    this.lastReceiptHash = await receiptHash(this.port, receipt);
    this.signerTip.set(event.signer, eh);
    if (rotation.range !== null) {
      const current = this.ranges[this.ranges.length - 1];
      if (current) {
        current.validTo = rotation.range.validFrom;
      }
      this.ranges.push(rotation.range);
    }
    return { ok: true };
  }

  private async checkRotation(
    event: SignedEvent,
  ): Promise<{ ok: true; range: KeyRange | null } | { ok: false; error: ApiError }> {
    if (event.type !== 'RelayKeyRotated') {
      return { ok: true, range: null };
    }
    const bad = (message: string, path: string): { ok: false; error: ApiError } => ({
      ok: false,
      error: { code: 'KEY_UNKNOWN', message, path },
    });
    const payload = event.payload;
    const newPubkey = Object.hasOwn(payload, 'pubkey') ? payload['pubkey'] : undefined;
    const vfs = Object.hasOwn(payload, 'valid_from_sequence') ? payload['valid_from_sequence'] : undefined;
    const kid = Object.hasOwn(payload, 'key_id') ? payload['key_id'] : undefined;
    if (typeof newPubkey !== 'string' || typeof vfs !== 'number' || typeof kid !== 'string') {
      return bad('RelayKeyRotated payload incomplete', '$.event.payload');
    }
    if (!Number.isSafeInteger(vfs)) {
      return bad('valid_from_sequence is not a safe integer', '$.event.payload.valid_from_sequence');
    }
    const current = this.ranges[this.ranges.length - 1];
    if (!current || vfs <= current.validFrom) {
      return bad('RelayKeyRotated does not open a valid new range', '$.event.payload.valid_from_sequence');
    }
    const computedKeyId = await sha256HexUtf8(this.port, newPubkey);
    if (computedKeyId !== kid) {
      return bad('key_id does not match sha256(pubkey)', '$.event.payload.key_id');
    }
    return { ok: true, range: { pubkey: newPubkey, keyId: kid, validFrom: vfs, validTo: null } };
  }

  /** Checks a checkpoint against the locally verified chain. */
  async verifyCheckpoint(cp: SignedCheckpoint): Promise<VerifyResult> {
    const body = {
      sequence: cp.sequence,
      receipt_hash: cp.receipt_hash,
      key_id: cp.key_id,
    };
    const range = this.ranges.find((r) => r.keyId === cp.key_id);
    if (!range) {
      return failure(
        'KEY_UNKNOWN',
        'Checkpoint key_id does not match any known key range',
        '$.checkpoint.key_id',
      );
    }
    const sigOk = await verifyAttestation(
      this.port,
      range.pubkey,
      'checkpoint',
      body,
      cp.signature,
    );
    if (!sigOk) {
      return failure(
        'ATTESTATION',
        'Checkpoint attestation is invalid',
        '$.checkpoint.signature',
      );
    }
    if (cp.sequence <= this.entries.length) {
      const local = await this.localReceiptHash(cp.sequence);
      if (local === null) {
        return failure(
          'RECEIPT_SEQUENCE',
          'Local chain has no entry for this sequence',
          '$.checkpoint.sequence',
        );
      }
      if (local !== cp.receipt_hash) {
        return failure(
          'DIVERGENCE',
          'Checkpoint receipt_hash differs from the locally computed chain',
          '$.checkpoint.receipt_hash',
        );
      }
    }
    return { ok: true };
  }

  /** Local receipt hash at a given sequence (1-based). */
  async localReceiptHash(sequence: number): Promise<Hash | null> {
    const idx = sequence - 1;
    if (idx < 0 || idx >= this.entries.length) {
      return null;
    }
    const entry = this.entries[idx];
    if (!entry) {
      return null;
    }
    return receiptHash(this.port, entry.receipt);
  }
}
