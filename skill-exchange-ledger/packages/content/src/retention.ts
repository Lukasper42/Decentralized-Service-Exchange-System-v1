import type { Hash } from '../../domain/src/protocol.js';
import { ContentError } from './errors.js';
import type { ContentStore } from './store.js';

/** Content is kept through the appeal deadline and deletable strictly after it; deletion never touches ledger hashes. */
export class Retention {
  constructor(private readonly appealDeadlineMs: number) {}
  isDeletable(nowMs: number): boolean { return nowMs > this.appealDeadlineMs; }
  async deleteIfAllowed(store: ContentStore, hash: Hash, nowMs: number): Promise<void> {
    if (!this.isDeletable(nowMs)) throw new ContentError('RETENTION', `not deletable before ${this.appealDeadlineMs}`);
    await store.delete(hash);
  }
}
