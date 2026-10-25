import type { LedgerEntry, SignedCheckpoint } from '../../chain-verifier/src/index.js';
import type { ErrorCode, EventCore, Hash, Pubkey, Receipt, Sig, SignedEvent } from '../../domain/src/protocol.js';
import type { AttestationKind } from '../../crypto/src/index.js';

/** Protocol codes plus the transport codes of the relay and the client's own integrity codes. */
export type ClientErrorCode =
  | ErrorCode
  | 'READ_ONLY' | 'RATE_LIMITED' | 'NOT_FOUND' | 'BAD_REQUEST' | 'TOO_LARGE' | 'STORE_FAILURE'
  /** The relay could not be reached or answered with something that is not the documented shape. */
  | 'TRANSPORT'
  /** The relay's answers contradict what the client verified or projected itself. Never retry blindly. */
  | 'DIVERGENCE'
  /** No signer is configured, or the signer refused. */
  | 'SIGNING';

export interface ClientError { readonly code: ClientErrorCode; readonly message: string; readonly path: string }
export type ClientResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ClientError };
export const cok = <T>(value: T): ClientResult<T> => ({ ok: true, value });
export const cerr = <T = never>(code: ClientErrorCode, message: string, path = ''): ClientResult<T> => ({ ok: false, error: { code, message, path } });

export interface SubmitReceipt { readonly receipt: Receipt; readonly duplicate: boolean }
export interface TipInfo { readonly tipSequence: number; readonly stateHash: Hash }
export interface EntriesPage { readonly entries: readonly LedgerEntry[]; readonly next: number | null }

/** Everything the client needs from a ledger node. The MVP adapter is the HTTP relay; a consensus node can replace it. */
export interface LedgerTransport {
  submit(event: SignedEvent): Promise<ClientResult<SubmitReceipt>>;
  tip(): Promise<ClientResult<TipInfo>>;
  entries(from: number, to: number): Promise<ClientResult<EntriesPage>>;
  signerTip(signer: Pubkey): Promise<ClientResult<Hash | null>>;
  latestCheckpoint(): Promise<ClientResult<SignedCheckpoint | null>>;
}

/** Signs on behalf of one account. The private key never leaves the implementation (keystore or test key). */
export interface EventSigner {
  readonly publicKey: Pubkey;
  signEvent(core: EventCore): Promise<ClientResult<SignedEvent>>;
  signAttestation(kind: AttestationKind, body: unknown): Promise<ClientResult<Sig>>;
}

/** Time source in epoch milliseconds (injected; the library never reads the wall clock). */
export interface ClientClock { nowMs(): number }
