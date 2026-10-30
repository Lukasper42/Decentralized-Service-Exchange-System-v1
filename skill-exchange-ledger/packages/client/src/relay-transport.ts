import type { SignedCheckpoint } from '../../chain-verifier/src/index.js';
import type { Hash, Pubkey, SignedEvent } from '../../domain/src/protocol.js';
import type { Relay, RelayResult } from '../../relay/src/relay.js';
import type { ClientResult, EntriesPage, LedgerTransport, SubmitReceipt, TipInfo } from './ports.js';
import { cerr, cok } from './ports.js';

function lift<T>(result: RelayResult<T>): ClientResult<T> {
  return result.ok ? cok(result.value) : cerr(result.error.code, result.error.message, result.error.path);
}

/** In-process transport over a Relay object: same contract as HTTP, without a socket. For tests and embedded nodes. */
export class RelayTransport implements LedgerTransport {
  constructor(private readonly relay: Relay) {}
  submit(event: SignedEvent): Promise<ClientResult<SubmitReceipt>> { return this.relay.submitAsync(event).then(lift); }
  tip(): Promise<ClientResult<TipInfo>> { return Promise.resolve(cok({ tipSequence: this.relay.tipSequence, stateHash: this.relay.stateHash })); }
  entries(from: number, to: number): Promise<ClientResult<EntriesPage>> {
    const clamped = Math.min(to, this.relay.tipSequence);
    return Promise.resolve(cok({ entries: from > clamped ? [] : this.relay.entries(from, clamped), next: null }));
  }
  signerTip(signer: Pubkey): Promise<ClientResult<Hash | null>> { return Promise.resolve(cok(this.relay.signerTip(signer))); }
  latestCheckpoint(): Promise<ClientResult<SignedCheckpoint | null>> { return Promise.resolve(cok(this.relay.latestCheckpoint())); }
}
