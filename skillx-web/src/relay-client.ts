import type {
  ErrorCode,
  Hash,
  LedgerEntry,
  PostEventResponse,
  Receipt,
  Result,
  SignedCheckpoint,
  SignedEvent,
  SignerTipResponse,
  TipResponse,
  HealthResponse,
  EntriesResponse,
  Pubkey,
} from './types.js';
import { err, ok } from './types.js';
import type { FetchInit, FetchPort } from './ports.js';
import {
  GuardError,
  field,
  guardArray,
  guardHash,
  guardIso,
  guardNullable,
  guardPositiveInt,
  guardSafeInt,
  guardString,
  isRecord,
  payloadRecord,
} from './guards.js';
import { EVENT_TYPES } from './types.js';
import { canonical, eventHash, relayKeyId, verifyReceiptWithKeyId } from './crypto.js';
import type { CryptoPort } from './ports.js';

const TIMEOUT_MS = 10000;

function transportError(message: string, path: string): Result<never> {
  return err('TRANSPORT', message, path);
}

function toApiError(e: unknown, fallbackPath: string): Result<never> {
  if (e instanceof GuardError) {
    return err(e.code as ErrorCode, e.message, e.gpath);
  }
  return err('TRANSPORT', 'Response has unexpected shape', fallbackPath);
}

async function requestJson(
  fetchPort: FetchPort,
  url: string,
  init?: FetchInit,
): Promise<Result<unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT_MS);
  try {
    const merged: FetchInit = { ...(init ?? {}) };
    merged.signal = controller.signal;
    const res = await fetchPort(url, merged);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return transportError('Response is not valid JSON', url);
    }
    if (res.status >= 400) {
      if (isRecord(body)) {
        try {
          const code = field(body, 'code', '$', guardString) as ErrorCode;
          const message = field(body, 'message', '$', guardString);
          const path = field(body, 'path', '$', guardString);
          return err(code, message.slice(0, 300), path.slice(0, 200));
        } catch {
          return transportError('Error response incomplete', url);
        }
      }
      return transportError('Error response is not an object', url);
    }
    return ok(body);
  } catch {
    return transportError('Network error or timeout', url);
  } finally {
    clearTimeout(timer);
  }
}

function parseSignedEvent(value: unknown, path: string): SignedEvent {
  if (!isRecord(value)) {
    throw new GuardError('ENVELOPE', 'Event must be an object', path);
  }
  const typeStr = field(value, 'type', path, guardString);
  let foundType: (typeof EVENT_TYPES)[number] | null = null;
  for (const t of EVENT_TYPES) {
    if (t === typeStr) {
      foundType = t;
      break;
    }
  }
  if (!foundType) {
    throw new GuardError('UNKNOWN_TYPE', `Unknown event type "${typeStr}"`, `${path}.type`);
  }
  const version = field(value, 'version', path, guardSafeInt);
  if (version !== 1) {
    throw new GuardError('VERSION', 'Only version 1 allowed', `${path}.version`);
  }
  return {
    type: foundType,
    version: 1,
    payload: payloadRecord(value, path),
    signer: field(value, 'signer', path, guardString),
    timestamp: field(value, 'timestamp', path, guardIso),
    prevHash: field(value, 'prevHash', path, (v, p) =>
      guardNullable(v, p, guardHash),
    ),
    signature: field(value, 'signature', path, guardString),
  };
}

function parseReceipt(value: unknown, path: string): Receipt {
  if (!isRecord(value)) {
    throw new GuardError('ENVELOPE', 'Receipt must be an object', path);
  }
  return {
    sequence: field(value, 'sequence', path, guardPositiveInt),
    eventHash: field(value, 'eventHash', path, guardHash),
    previousReceiptHash: field(value, 'previousReceiptHash', path, (v, p) =>
      guardNullable(v, p, guardHash),
    ),
    acceptedAt: field(value, 'acceptedAt', path, guardIso),
    keyId: field(value, 'keyId', path, guardHash),
    signature: field(value, 'signature', path, guardString),
  };
}

function parseLedgerEntry(value: unknown, path: string): LedgerEntry {
  if (!isRecord(value)) {
    throw new GuardError('ENVELOPE', 'Entry must be an object', path);
  }
  return {
    event: parseSignedEvent(field(value, 'event', path, (v, p) => v && isRecord(v) ? v : failObj(p)), path + '.event'),
    receipt: parseReceipt(field(value, 'receipt', path, (v, p) => v && isRecord(v) ? v : failObj(p)), path + '.receipt'),
  };
}

function failObj(path: string): never {
  throw new GuardError('ENVELOPE', 'Object expected', path);
}

function parseCheckpoint(value: unknown, path: string): SignedCheckpoint {
  if (!isRecord(value)) {
    throw new GuardError('ENVELOPE', 'Checkpoint must be an object', path);
  }
  return {
    sequence: field(value, 'sequence', path, guardPositiveInt),
    receipt_hash: field(value, 'receipt_hash', path, guardHash),
    key_id: field(value, 'key_id', path, guardHash),
    signature: field(value, 'signature', path, guardString),
  };
}

export class RelayClient {
  readonly baseUrl: string;
  private readonly fetchPort: FetchPort;

  constructor(baseUrl: string, fetchPort: FetchPort) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchPort = fetchPort;
  }

  async health(): Promise<Result<HealthResponse>> {
    const r = await requestJson(this.fetchPort, `${this.baseUrl}/v1/health`);
    if (!r.ok) {
      return r;
    }
    try {
      if (!isRecord(r.value)) {
        return transportError('Health response is not an object', '/v1/health');
      }
      const okFlag = field(r.value, 'ok', '$', (v, p) => {
        if (v !== true) {
          throw new GuardError('STATE', 'ok is not true', p);
        }
        return true as const;
      });
      const readOnly = field(r.value, 'readOnly', '$', (v, p) => {
        if (typeof v !== 'boolean') {
          throw new GuardError('FIELD_FORMAT', 'Boolean expected', p);
        }
        return v;
      });
      const tip = field(r.value, 'tip', '$', guardSafeInt);
      return ok({ ok: okFlag, readOnly, tip });
    } catch (e) {
      return toApiError(e, '/v1/health');
    }
  }

  async tip(): Promise<Result<TipResponse>> {
    const r = await requestJson(this.fetchPort, `${this.baseUrl}/v1/tip`);
    if (!r.ok) {
      return r;
    }
    try {
      if (!isRecord(r.value)) {
        return transportError('Tip response is not an object', '/v1/tip');
      }
      return ok({
        tipSequence: field(r.value, 'tipSequence', '$', guardPositiveInt),
        stateHash: field(r.value, 'stateHash', '$', guardHash),
      });
    } catch (e) {
      return toApiError(e, '/v1/tip');
    }
  }

  async latestCheckpoint(): Promise<Result<SignedCheckpoint>> {
    const r = await requestJson(this.fetchPort, `${this.baseUrl}/v1/checkpoints/latest`);
    if (!r.ok) {
      return r;
    }
    try {
      return ok(parseCheckpoint(r.value, '$'));
    } catch (e) {
      return toApiError(e, '/v1/checkpoints/latest');
    }
  }

  async entries(from: number, to: number): Promise<Result<EntriesResponse>> {
    const url = `${this.baseUrl}/v1/entries?from=${from}&to=${to}`;
    const r = await requestJson(this.fetchPort, url);
    if (!r.ok) {
      return r;
    }
    try {
      if (!isRecord(r.value)) {
        return transportError('Entries response is not an object', url);
      }
      const list = field(r.value, 'entries', '$', (v, p) =>
        guardArray(v, p, (x, xp) => parseLedgerEntry(x, xp)),
      );
      const next = field(r.value, 'next', '$', (v, p) =>
        v === null ? null : guardPositiveInt(v, p),
      );
      return ok({ entries: list, next });
    } catch (e) {
      return toApiError(e, url);
    }
  }

  async signerTip(pubkey: Pubkey): Promise<Result<SignerTipResponse>> {
    const url = `${this.baseUrl}/v1/signers/${encodeURIComponent(pubkey)}/tip`;
    const r = await requestJson(this.fetchPort, url);
    if (!r.ok) {
      return r;
    }
    try {
      if (!isRecord(r.value)) {
        return transportError('Signer tip response is not an object', url);
      }
      return ok({
        signer: field(r.value, 'signer', '$', guardString),
        tip: field(r.value, 'tip', '$', (v, p) => guardNullable(v, p, guardHash)),
      });
    } catch (e) {
      return toApiError(e, url);
    }
  }

  async postEvent(event: SignedEvent): Promise<Result<PostEventResponse>> {
    const url = `${this.baseUrl}/v1/events`;
    const r = await requestJson(this.fetchPort, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: canonical(event),
    });
    if (!r.ok) {
      return r;
    }
    try {
      if (!isRecord(r.value)) {
        return transportError('Post response is not an object', url);
      }
      const receipt = parseReceipt(
        field(r.value, 'receipt', '$', (v, p) => (isRecord(v) ? v : failObj(p))),
        '$.receipt',
      );
      const duplicate = field(r.value, 'duplicate', '$', (v, p) => {
        if (typeof v !== 'boolean') {
          throw new GuardError('FIELD_FORMAT', 'Boolean expected', p);
        }
        return v;
      });
      return ok({ receipt, duplicate });
    } catch (e) {
      return toApiError(e, url);
    }
  }
}

/**
 * Checks a received receipt against the locally sent event (steps 3 and 5
 * of section 4) and returns the validated result.
 */
export async function validatePostReceipt(
  crypto: CryptoPort,
  relayPubkey: Pubkey,
  sentEvent: SignedEvent,
  receipt: Receipt,
): Promise<Result<Receipt>> {
  const eh: Hash = await eventHash(crypto, sentEvent);
  if (receipt.eventHash !== eh) {
    return err(
      'DIVERGENCE',
      'Receipt eventHash does not match the sent event',
      '$.receipt.eventHash',
    );
  }
  const expectedKeyId = await relayKeyId(crypto, relayPubkey);
  const okSig = await verifyReceiptWithKeyId(crypto, receipt, relayPubkey, expectedKeyId);
  if (!okSig) {
    return err(
      'DIVERGENCE',
      'Receipt signature could not be verified against the pinned relay key',
      '$.receipt.signature',
    );
  }
  return ok(receipt);
}

export { parseSignedEvent, parseReceipt, parseLedgerEntry, parseCheckpoint };
