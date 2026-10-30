import type { ChainVerifier } from './verify.js';
import type { RelayClient } from './relay-client.js';
import type { Vault } from './vault.js';
import type {
  ApiError,
  HealthResponse,
  LedgerEntry,
  Pubkey,
  SignedCheckpoint,
} from './types.js';

export interface SyncState {
  running: boolean;
  lastSyncOk: boolean;
  lastError: ApiError | null;
}

export interface AppState {
  relayUrl: string;
  relayPubkey: Pubkey | null;
  client: RelayClient | null;
  verifier: ChainVerifier | null;
  health: HealthResponse | null;
  tipSequence: number | null;
  stateHash: string | null;
  localLength: number;
  entries: LedgerEntry[];
  checkpoint: SignedCheckpoint | null;
  checkpointVerified: boolean | null;
  vault: Vault | null;
  ownPubkey: Pubkey | null;
  unlocked: boolean;
  signingKey: CryptoKey | null;
  sync: SyncState;
  actionMessage: string | null;
  actionError: ApiError | null;
}

type Listener = (state: AppState) => void;

export class Store {
  private state: AppState;
  private listeners: Set<Listener> = new Set();

  constructor(initial?: Partial<AppState>) {
    this.state = {
      relayUrl: '',
      relayPubkey: null,
      client: null,
      verifier: null,
      health: null,
      tipSequence: null,
      stateHash: null,
      localLength: 0,
      entries: [],
      checkpoint: null,
      checkpointVerified: null,
      vault: null,
      ownPubkey: null,
      unlocked: false,
      signingKey: null,
      sync: { running: false, lastSyncOk: true, lastError: null },
      actionMessage: null,
      actionError: null,
      ...initial,
    };
  }

  get(): AppState {
    return this.state;
  }

  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Wie subscribe, ruft den Listener aber sofort mit dem aktuellen Zustand auf (Ansichten brauchen den Anfangszustand). */
  subscribeNow(listener: Listener): () => void {
    const unsubscribe = this.subscribe(listener);
    listener(this.state);
    return unsubscribe;
  }

  private emit(): void {
    for (const l of this.listeners) {
      l(this.state);
    }
  }
}
