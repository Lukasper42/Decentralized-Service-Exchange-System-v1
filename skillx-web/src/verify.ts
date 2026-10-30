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
  // Feste Breite -> lexikographische Ordnung entspricht der Zeitordnung.
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

  /** Initialisiert keyId des ersten Bereichs (async, da Hash berechnet wird). */
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

    // 1. Sequenz
    const expectedSeq = this.entries.length + 1;
    if (receipt.sequence !== expectedSeq) {
      return failure(
        'RECEIPT_SEQUENCE',
        `Erwartete Sequenz ${expectedSeq}, erhalten ${receipt.sequence}`,
        `${p}.receipt.sequence`,
      );
    }

    // 2. Event-Signatur
    let eventSigOk = false;
    try {
      eventSigOk = await verifyEvent(this.port, event);
    } catch {
      eventSigOk = false;
    }
    if (!eventSigOk) {
      return failure('SIGNATURE', 'Event-Signatur ist ungültig', `${p}.event.signature`);
    }

    // 3. Event-Hash
    const eh = await eventHash(this.port, event);
    if (eh !== receipt.eventHash) {
      return failure(
        'RECEIPT_EVENT_HASH',
        'receipt.eventHash stimmt nicht mit dem Event überein',
        `${p}.receipt.eventHash`,
      );
    }

    // 4. Receipt-Verkettung
    if (receipt.previousReceiptHash !== this.lastReceiptHash) {
      return failure(
        'RECEIPT_LINK',
        'previousReceiptHash passt nicht zum vorherigen Eintrag',
        `${p}.receipt.previousReceiptHash`,
      );
    }

    // 5. Schlüsselbereich + Receipt-Signatur
    const range = this.rangeFor(receipt.sequence);
    if (!range) {
      return failure(
        'KEY_UNKNOWN',
        `Kein Schlüsselbereich deckt Sequenz ${receipt.sequence} ab`,
        `${p}.receipt.keyId`,
      );
    }
    if (receipt.keyId !== range.keyId) {
      return failure(
        'KEY_UNKNOWN',
        'receipt.keyId passt nicht zum gültigen Schlüsselbereich',
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
        'Receipt-Signatur ist für den Relay-Schlüssel ungültig',
        `${p}.receipt.signature`,
      );
    }

    // 6. Per-Signer-Kette
    const prevExpected = this.signerTip.get(event.signer) ?? null;
    if (event.prevHash !== prevExpected) {
      return failure(
        'CHAIN_LINK',
        'event.prevHash entspricht nicht dem letzten Event dieses Signers',
        `${p}.event.prevHash`,
      );
    }

    // 7. monotones acceptedAt
    const lastEntry = this.entries[this.entries.length - 1];
    if (lastEntry) {
      if (compareIso(receipt.acceptedAt, lastEntry.receipt.acceptedAt) < 0) {
        return failure(
          'RECEIPT_SEQUENCE',
          'receipt.acceptedAt fällt unter das vorherige acceptedAt zurück',
          `${p}.receipt.acceptedAt`,
        );
      }
    }

    // 8. Relay-Schlüsselwechsel prüfen, bevor etwas übernommen wird
    const rotation = await this.checkRotation(event);
    if (!rotation.ok) {
      return { ok: false, error: rotation.error };
    }

    // Alles geprüft: übernehmen
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
      return bad('RelayKeyRotated-Payload unvollständig', '$.event.payload');
    }
    if (!Number.isSafeInteger(vfs)) {
      return bad('valid_from_sequence ist keine sichere Ganzzahl', '$.event.payload.valid_from_sequence');
    }
    const current = this.ranges[this.ranges.length - 1];
    if (!current || vfs <= current.validFrom) {
      return bad('RelayKeyRotated öffnet keinen gültigen neuen Bereich', '$.event.payload.valid_from_sequence');
    }
    const computedKeyId = await sha256HexUtf8(this.port, newPubkey);
    if (computedKeyId !== kid) {
      return bad('key_id stimmt nicht mit sha256(pubkey) überein', '$.event.payload.key_id');
    }
    return { ok: true, range: { pubkey: newPubkey, keyId: kid, validFrom: vfs, validTo: null } };
  }

  /** Prüft einen Checkpoint gegen die lokal verifizierte Kette. */
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
        'Checkpoint-Key_id entspricht keinem bekannten Schlüsselbereich',
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
        'Checkpoint-Attestation ist ungültig',
        '$.checkpoint.signature',
      );
    }
    if (cp.sequence <= this.entries.length) {
      const local = await this.localReceiptHash(cp.sequence);
      if (local === null) {
        return failure(
          'RECEIPT_SEQUENCE',
          'Lokale Kette hat keinen Eintrag für diese Sequenz',
          '$.checkpoint.sequence',
        );
      }
      if (local !== cp.receipt_hash) {
        return failure(
          'DIVERGENCE',
          'Checkpoint-receipt_hash weicht von der lokal berechneten Kette ab',
          '$.checkpoint.receipt_hash',
        );
      }
    }
    return { ok: true };
  }

  /** Lokaler Receipt-Hash an einer gegebenen Sequenz (1-basiert). */
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
