import type { Hash } from '../../domain/src/protocol.js';
import { canonical } from '../../crypto/src/index.js';
import type { ContentStore } from './store.js';

export interface PrecheckInput { contentHash: Hash; content: Uint8Array }
/** `result` uses the protocol's PrecheckCompleted vocabulary. */
export interface PrecheckReport { contentHash: Hash; result: 'pass' | 'fail' | 'inconclusive'; reasons: string[]; model: string }
export interface PrecheckAdapter { check(input: PrecheckInput): Promise<PrecheckReport> }

/** Deterministic fake for tests: flags content containing any keyword. */
export class KeywordPrecheck implements PrecheckAdapter {
  constructor(private readonly keywords: readonly string[], private readonly model = 'fake-keyword') {}
  check(input: PrecheckInput): Promise<PrecheckReport> {
    const text = Buffer.from(input.content).toString('utf8').toLowerCase();
    const hits = this.keywords.filter((k) => text.includes(k.toLowerCase()));
    return Promise.resolve({ contentHash: input.contentHash, result: hits.length > 0 ? 'fail' : 'pass', reasons: hits.map((h) => `keyword:${h}`), model: this.model });
  }
}
export interface PrecheckOutcome {
  /** Hash of the stored report blob: goes into `DeliverableSubmitted.precheck_ref`; the report itself stays off the ledger. */
  precheckRef: Hash;
  /** The `result` field of `PrecheckCompleted` (informational only, spec section 6). */
  result: PrecheckReport['result'];
  contentHash: Hash;
}
/** Run the adapter, store the canonical report as a blob and return only what the ledger may carry. */
export async function runPrecheck(adapter: PrecheckAdapter, store: ContentStore, input: PrecheckInput): Promise<PrecheckOutcome> {
  const report = await adapter.check(input);
  const precheckRef = await store.put(Buffer.from(canonical(report), 'utf8'));
  return { precheckRef, result: report.result, contentHash: input.contentHash };
}
