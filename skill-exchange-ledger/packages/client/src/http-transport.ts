import type { LedgerEntry, SignedCheckpoint } from '../../chain-verifier/src/index.js';
import { ERROR_CODES } from '../../domain/src/protocol.js';
import type { Hash, Pubkey, Receipt, SignedEvent } from '../../domain/src/protocol.js';
import type { ClientErrorCode, ClientResult, EntriesPage, LedgerTransport, SubmitReceipt, TipInfo } from './ports.js';
import { cerr, cok } from './ports.js';

export interface HttpTransportOptions {
  /** Base URL of the relay, e.g. `https://relay.example`. No trailing path. */
  readonly baseUrl: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const TRANSPORT_CODES: readonly string[] = ['READ_ONLY', 'RATE_LIMITED', 'NOT_FOUND', 'BAD_REQUEST', 'TOO_LARGE', 'STORE_FAILURE'];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isKnownCode = (value: unknown): value is ClientErrorCode =>
  typeof value === 'string' && ((ERROR_CODES as readonly string[]).includes(value) || TRANSPORT_CODES.includes(value));

/** HTTP adapter for the relay's /v1 API. Never throws: network and format problems become TRANSPORT errors. */
export class HttpTransport implements LedgerTransport {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpTransportOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ClientResult<{ status: number; json: unknown }>> {
    let response: Response;
    try {
      const init: RequestInit = { method, signal: AbortSignal.timeout(this.#timeoutMs), headers: { accept: 'application/json' } };
      if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { accept: 'application/json', 'content-type': 'application/json' }; }
      response = await this.#fetch(`${this.#base}${path}`, init);
    } catch {
      return cerr('TRANSPORT', 'The relay could not be reached', path);
    }
    let json: unknown;
    try { json = await response.json(); } catch { return cerr('TRANSPORT', 'The relay answered with something that is not JSON', path); }
    if (response.ok) return cok({ status: response.status, json });
    if (isRecord(json) && isKnownCode(json.code) && typeof json.message === 'string') {
      return cerr(json.code, json.message, typeof json.path === 'string' ? json.path : path);
    }
    return cerr('TRANSPORT', `The relay answered with HTTP ${response.status}`, path);
  }

  async submit(event: SignedEvent): Promise<ClientResult<SubmitReceipt>> {
    const result = await this.#call('POST', '/v1/events', event);
    if (!result.ok) return result;
    const json = result.value.json;
    if (!isRecord(json) || !isRecord(json.receipt) || typeof json.duplicate !== 'boolean') return cerr('TRANSPORT', 'Unexpected submit response', '/v1/events');
    return cok({ receipt: json.receipt as unknown as Receipt, duplicate: json.duplicate });
  }

  async tip(): Promise<ClientResult<TipInfo>> {
    const result = await this.#call('GET', '/v1/tip');
    if (!result.ok) return result;
    const json = result.value.json;
    if (!isRecord(json) || typeof json.tipSequence !== 'number' || !Number.isSafeInteger(json.tipSequence) || typeof json.stateHash !== 'string') return cerr('TRANSPORT', 'Unexpected tip response', '/v1/tip');
    return cok({ tipSequence: json.tipSequence, stateHash: json.stateHash });
  }

  async entries(from: number, to: number): Promise<ClientResult<EntriesPage>> {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1) return cerr('BAD_REQUEST', 'from/to must be positive integers', 'query');
    const result = await this.#call('GET', `/v1/entries?from=${from}&to=${to}`);
    if (!result.ok) return result;
    const json = result.value.json;
    if (!isRecord(json) || !Array.isArray(json.entries) || !(json.next === null || typeof json.next === 'number')) return cerr('TRANSPORT', 'Unexpected entries response', '/v1/entries');
    return cok({ entries: json.entries as LedgerEntry[], next: json.next });
  }

  async signerTip(signer: Pubkey): Promise<ClientResult<Hash | null>> {
    const result = await this.#call('GET', `/v1/signers/${encodeURIComponent(signer)}/tip`);
    if (!result.ok) return result;
    const json = result.value.json;
    if (!isRecord(json) || !(json.tip === null || typeof json.tip === 'string')) return cerr('TRANSPORT', 'Unexpected signer tip response', '/v1/signers');
    return cok(json.tip);
  }

  async latestCheckpoint(): Promise<ClientResult<SignedCheckpoint | null>> {
    const result = await this.#call('GET', '/v1/checkpoints/latest');
    if (!result.ok) return result.error.code === 'NOT_FOUND' ? cok(null) : result;
    const json = result.value.json;
    if (!isRecord(json) || typeof json.sequence !== 'number' || typeof json.receipt_hash !== 'string' || typeof json.key_id !== 'string' || typeof json.signature !== 'string') return cerr('TRANSPORT', 'Unexpected checkpoint response', '/v1/checkpoints/latest');
    return cok({ sequence: json.sequence, receipt_hash: json.receipt_hash, key_id: json.key_id, signature: json.signature });
  }
}
