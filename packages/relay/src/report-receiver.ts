import { appendFile, readFile } from 'node:fs/promises';
import { canonical, strictVerify } from '../../crypto/src/index.js';
import type { Hash, Pubkey } from '../../domain/src/protocol.js';
import type { RelayError } from './relay.js';
import { ok } from '../../domain/src/protocol.js';
import { REPORT_DOMAIN, REPORT_VERSION, stableFindingId } from '../../listener/src/circular-trading-report.js';
import type { CircularTradingReport, TransferReference } from '../../listener/src/circular-trading-report.js';
import type { ClockPort } from './ports.js';

export type ReportResult<T> = { ok: true; value: T } | { ok: false; error: RelayError };

export interface ListenerKeyAllowlistEntry {
  readonly pubkey: Pubkey;
  readonly valid_from_sequence: number;
  readonly valid_to_sequence: number;
}

export type ReportDeliveryOutcome = 'delivered' | 'retryable' | 'permanent';

export interface ReportOutbox {
  append(report: CircularTradingReport): Promise<void>;
}

const HASH = /^[a-f0-9]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const REPORT_KEYS = ['report_version', 'rule_id', 'account_a', 'account_b', 'forward', 'reverse', 'through_sequence', 'through_receipt_hash', 'finding_id', 'listener_pubkey', 'created_at', 'signature'];
const REFERENCE_KEYS = ['deal_id', 'release_event_hash', 'sequence', 'amount', 'accepted_at'];

const isHash = (value: unknown): value is Hash => typeof value === 'string' && HASH.test(value);
const isIsoUtc = (value: unknown): value is string => typeof value === 'string' && ISO_UTC.test(value);
const isPubkey = (value: unknown): value is Pubkey => typeof value === 'string' && value.length > 0;
const isPositiveSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && !Object.is(value, -0);

function badRequest(message: string, path: string): ReportResult<never> {
  return { ok: false, error: { code: 'BAD_REQUEST', message, path } };
}

function validateReference(value: unknown, path: string): ReportResult<TransferReference> {
  if (typeof value !== 'object' || value === null) return badRequest('Reference must be an object', path);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...REFERENCE_KEYS].sort().join(',')) return badRequest('Reference has unexpected fields', path);
  if (typeof record.deal_id !== 'string' || record.deal_id.length === 0) return badRequest('deal_id must be a non-empty string', `${path}.deal_id`);
  if (!isHash(record.release_event_hash)) return badRequest('release_event_hash must be a 64-character hex hash', `${path}.release_event_hash`);
  if (!isPositiveSafeInteger(record.sequence)) return badRequest('sequence must be a positive safe integer', `${path}.sequence`);
  if (!isPositiveSafeInteger(record.amount)) return badRequest('amount must be a positive safe integer', `${path}.amount`);
  if (!isIsoUtc(record.accepted_at)) return badRequest('accepted_at must be an ISO-8601 UTC timestamp', `${path}.accepted_at`);
  return ok(record as unknown as TransferReference);
}

/** Validate the wire shape, recompute the stable finding id, verify the signature, and check listener authority. */
export function validateReport(input: unknown, allowlist: readonly ListenerKeyAllowlistEntry[]): ReportResult<CircularTradingReport> {
  if (typeof input !== 'object' || input === null) return badRequest('Report must be an object', '$');
  const report = input as Record<string, unknown>;
  if (Object.keys(report).sort().join(',') !== [...REPORT_KEYS].sort().join(',')) return badRequest('Report has unexpected fields', '$');
  if (report.report_version !== REPORT_VERSION) return badRequest('Unsupported report version', 'report_version');
  if (report.rule_id !== 'circular-trading-pair') return badRequest('Unknown rule', 'rule_id');
  if (!isPubkey(report.account_a) || !isPubkey(report.account_b)) return badRequest('account_a and account_b must be public keys', 'account_a');
  if (Buffer.compare(Buffer.from(report.account_a, 'utf8'), Buffer.from(report.account_b, 'utf8')) >= 0) return badRequest('Account pair must be in canonical order', 'account_a');
  const forward = validateReference(report.forward, 'forward');
  if (!forward.ok) return forward;
  const reverse = validateReference(report.reverse, 'reverse');
  if (!reverse.ok) return reverse;
  if (!isPositiveSafeInteger(report.through_sequence)) return badRequest('through_sequence must be a positive safe integer', 'through_sequence');
  const throughSequence = report.through_sequence as number;
  if (!isHash(report.through_receipt_hash)) return badRequest('through_receipt_hash must be a 64-character hex hash', 'through_receipt_hash');
  if (!isHash(report.finding_id)) return badRequest('finding_id must be a 64-character hex hash', 'finding_id');
  if (!isPubkey(report.listener_pubkey)) return badRequest('listener_pubkey must be a public key', 'listener_pubkey');
  if (!isIsoUtc(report.created_at)) return badRequest('created_at must be an ISO-8601 UTC timestamp', 'created_at');
  if (typeof report.signature !== 'string' || report.signature.length === 0) return badRequest('signature must be a Base64 string', 'signature');

  const expectedFindingId = stableFindingId({
    ruleId: 'circular-trading-pair',
    accountA: report.account_a,
    accountB: report.account_b,
    forward: {
      dealId: forward.value.deal_id,
      from: report.account_a,
      to: report.account_b,
      amount: forward.value.amount,
      acceptedAt: forward.value.accepted_at,
      sequence: forward.value.sequence,
      releaseEventHash: forward.value.release_event_hash,
    },
    reverse: {
      dealId: reverse.value.deal_id,
      from: report.account_b,
      to: report.account_a,
      amount: reverse.value.amount,
      acceptedAt: reverse.value.accepted_at,
      sequence: reverse.value.sequence,
      releaseEventHash: reverse.value.release_event_hash,
    },
  });
  if (report.finding_id !== expectedFindingId) return badRequest('finding_id does not match the finding', 'finding_id');

  const unsigned = { ...report } as Record<string, unknown>;
  delete unsigned.signature;
  const payload = Buffer.from(REPORT_DOMAIN + canonical(unsigned), 'utf8');
  if (!strictVerify(payload, report.signature, report.listener_pubkey)) return { ok: false, error: { code: 'SIGNATURE', message: 'Report signature is invalid', path: 'signature' } };

  const authorized = allowlist.some((entry) => entry.pubkey === report.listener_pubkey && throughSequence >= entry.valid_from_sequence && throughSequence <= entry.valid_to_sequence);
  if (!authorized) return { ok: false, error: { code: 'SIGNER_AUTHORITY', message: 'Listener key is not authorized for this sequence', path: 'listener_pubkey' } };

  return ok(report as unknown as CircularTradingReport);
}

export interface ReportReceiverDeps {
  readonly allowlist: readonly ListenerKeyAllowlistEntry[];
  readonly outbox: ReportOutbox;
  readonly knownFindingIds?: readonly Hash[];
}

/**
 * Off-ledger receiver for circular-trading reports. It never touches ledger state: acceptance records the finding id
 * and hands the report to the NDJSON outbox for at-least-once delivery.
 */
export class ReportReceiver {
  private readonly accepted = new Set<Hash>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ReportReceiverDeps) {
    for (const findingId of deps.knownFindingIds ?? []) this.accepted.add(findingId);
  }

  /** Serializes accepts so concurrent duplicates cannot both pass the idempotency check. */
  accept(input: unknown): Promise<ReportResult<{ readonly findingId: Hash; readonly duplicate: boolean }>> {
    const next = this.queue.then(() => this.acceptInner(input));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async acceptInner(input: unknown): Promise<ReportResult<{ readonly findingId: Hash; readonly duplicate: boolean }>> {
    const report = validateReport(input, this.deps.allowlist);
    if (!report.ok) return report;
    if (this.accepted.has(report.value.finding_id)) return ok({ findingId: report.value.finding_id, duplicate: true });
    try {
      await this.deps.outbox.append(report.value);
    } catch {
      return { ok: false, error: { code: 'STORE_FAILURE', message: 'Failed to persist report', path: '' } };
    }
    this.accepted.add(report.value.finding_id);
    return ok({ findingId: report.value.finding_id, duplicate: false });
  }
}

export interface NdjsonReportOutboxOptions {
  readonly path: string;
  readonly deliver: (report: CircularTradingReport) => Promise<ReportDeliveryOutcome>;
  readonly clock: ClockPort;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly appendLine?: (path: string, line: string) => Promise<void>;
  readonly onExhausted?: (report: CircularTradingReport) => void;
}

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const defaultAppendLine = (path: string, line: string) => appendFile(path, line, 'utf8');

/** Local NDJSON outbox: append first, then deliver with exponential backoff. Permanent failures are never retried. */
export class NdjsonReportOutbox implements ReportOutbox {
  constructor(private readonly options: NdjsonReportOutboxOptions) {}

  async append(report: CircularTradingReport): Promise<void> {
    const appendLine = this.options.appendLine ?? defaultAppendLine;
    await appendLine(this.options.path, `${JSON.stringify(report)}
`);
    void this.deliverWithBackoff(report);
  }

  private async deliverWithBackoff(report: CircularTradingReport): Promise<void> {
    const maxAttempts = this.options.maxAttempts ?? 5;
    const baseBackoffMs = this.options.baseBackoffMs ?? 100;
    const delay = this.options.delay ?? defaultDelay;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const outcome = await this.options.deliver(report).catch(() => 'retryable' as const);
      if (outcome !== 'retryable') return;
      if (attempt === maxAttempts) {
        this.options.onExhausted?.(report);
        return;
      }
      await delay(baseBackoffMs * 2 ** (attempt - 1));
    }
  }

  /** Loads finding ids already persisted in the NDJSON file so idempotency survives restarts. */
  async loadFindingIds(): Promise<Hash[]> {
    try {
      const text = await readFile(this.options.path, 'utf8');
      const lines = text.split(String.fromCharCode(10));
      const ids: Hash[] = [];
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        ids.push((JSON.parse(line) as CircularTradingReport).finding_id);
      }
      return ids;
    } catch {
      return [];
    }
  }
  }
