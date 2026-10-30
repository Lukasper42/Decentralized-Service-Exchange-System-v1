import type { Hash, IsoUtc, Pubkey, SignedEvent } from '../../domain/src/protocol.js';
import { recoveryCommitment } from '../../crypto/src/index.js';
import { KeystoreError, kerr, kok } from './errors.js';
import type { KResult } from './errors.js';
import { uniformIndex, wipe } from './bytes.js';
import { generateSeedPhrase } from './bip39.js';
import type { Wordlist } from './bip39.js';
import { Keystore } from './keystore.js';
import type { KdfParams, Role } from './keystore.js';
import type { ClockPort, EntropyPort, SigningPolicy } from './ports.js';

export type RecoveryState = 'idle' | 'seed_shown' | 'verifying' | 'verified' | 'active' | 'recovering' | 'rotation_built' | 'rotated' | 'failed';
const MAX_ATTEMPTS = 3;
const CHALLENGE_SIZE = 3;

export interface AccountCreatedDraft { pubkey: Pubkey; recovery_commitment: Hash; invite_ref: Hash | null }

/**
 * Create / restore workflow as an explicit state machine. The mnemonic is returned exactly once by beginCreation
 * and is dropped at commit, so "show once" is structural. Failure paths: wrong word, attempts exhausted, wrong
 * commitment, wrong state. Rotation is effective at its receipt sequence (spec section 3), never retroactive.
 */
export class RecoveryFlow {
  #state: RecoveryState = 'idle';
  #mnemonic: string | null = null;
  #seed: Buffer | null = null;
  #challenge: number[] = [];
  #attempts = 0;
  #recovery: Keystore | null = null;
  #lastError: string | null = null;

  constructor(private readonly deps: { entropy: EntropyPort; clock: ClockPort; wordlist: Wordlist; policy?: SigningPolicy; kdf?: Partial<KdfParams> }) {}

  get state(): RecoveryState { return this.#state; }
  get lastError(): string | null { return this.#lastError; }
  get challenge(): readonly number[] {
    if (this.#state !== 'verifying') throw new KeystoreError('E_STATE', this.#state);
    return [...this.#challenge];
  }
  #need(...allowed: RecoveryState[]): void {
    if (!allowed.includes(this.#state)) throw new KeystoreError('E_STATE', this.#state);
  }
  #fail(code: string): void { this.#lastError = code; this.#state = 'failed'; }
  #pick(count: number): number[] {
    const picked = new Set<number>();
    while (picked.size < CHALLENGE_SIZE) picked.add(uniformIndex(this.deps.entropy, count));
    return [...picked].sort((a, b) => a - b);
  }

  /** idle -> seed_shown. The only moment the words leave the flow. */
  beginCreation(strengthBits = 128): { state: RecoveryState; words: string[] } {
    this.#need('idle');
    const { mnemonic, seed } = generateSeedPhrase(this.deps.entropy, this.deps.wordlist, strengthBits);
    this.#mnemonic = mnemonic;
    this.#seed = seed;
    this.#challenge = this.#pick(mnemonic.split(' ').length);
    this.#state = 'seed_shown';
    return { state: this.#state, words: mnemonic.split(' ') };
  }
  /** seed_shown -> verifying */
  acknowledgeSeed(): { state: RecoveryState; challenge: readonly number[] } {
    this.#need('seed_shown');
    this.#attempts = 0;
    this.#state = 'verifying';
    return { state: this.#state, challenge: this.challenge };
  }
  /** verifying -> verified; after three wrong answers the seed must be shown again with a new challenge. */
  answerChallenge(answers: ReadonlyArray<{ index: number; word: string }>): { ok: boolean; state: RecoveryState; reason?: 'wrong_word' | 'attempts_exhausted'; remaining?: number } {
    this.#need('verifying');
    const words = (this.#mnemonic ?? '').split(' ');
    const given: ReadonlyArray<{ index: number; word: string }> = answers;
    const ok = given.length === this.#challenge.length
      && given.every((a, i) => typeof a === 'object' && a.index === this.#challenge[i] && words[a.index] === a.word);
    if (ok) { this.#state = 'verified'; return { ok: true, state: this.#state }; }
    this.#attempts += 1;
    if (this.#attempts >= MAX_ATTEMPTS) {
      this.#challenge = this.#pick(words.length);
      this.#attempts = 0;
      this.#state = 'seed_shown';
      return { ok: false, state: this.#state, reason: 'attempts_exhausted' };
    }
    return { ok: false, state: this.#state, reason: 'wrong_word', remaining: MAX_ATTEMPTS - this.#attempts };
  }
  /** verified -> active. Returns the encrypted file and the AccountCreated payload (no mnemonic, no key material). */
  async commit(args: { passphrase: string; label?: string; inviteRef?: Hash | null }): Promise<{ file: string; accountCreated: AccountCreatedDraft; keystore: Keystore }> {
    this.#need('verified');
    if (this.#seed === null) throw new KeystoreError('E_STATE', 'no seed');
    const created = await Keystore.create({
      seed: this.#seed, passphrase: args.passphrase, entropy: this.deps.entropy, clock: this.deps.clock,
      ...(this.deps.policy === undefined ? {} : { policy: this.deps.policy }), ...(args.label === undefined ? {} : { label: args.label }),
      ...(this.deps.kdf === undefined ? {} : { kdf: this.deps.kdf }),
    });
    wipe(this.#seed);
    this.#seed = null;
    this.#mnemonic = null;
    this.#state = 'active';
    const identity = created.keystore.identity;
    return { file: created.file, keystore: created.keystore, accountCreated: { pubkey: identity.accountPublicKey, recovery_commitment: identity.recoveryCommitment, invite_ref: args.inviteRef ?? null } };
  }

  /** idle|active -> recovering. The mnemonic must reproduce the commitment recorded on the ledger. */
  beginRecovery(args: { mnemonic: unknown; expectedCommitment: Hash }): KResult<RecoveryState> {
    this.#need('idle', 'active');
    const restored = Keystore.fromMnemonic({ mnemonic: args.mnemonic, wordlist: this.deps.wordlist, roles: ['recovery'] as Role[], ...(this.deps.policy === undefined ? {} : { policy: this.deps.policy }) });
    if (!restored.ok) { this.#fail(restored.code); return restored; }
    if (recoveryCommitment(restored.value.identity.recoveryPublicKey ?? '') !== args.expectedCommitment) {
      restored.value.destroy();
      this.#fail('E_COMMITMENT_MISMATCH');
      return kerr('E_COMMITMENT_MISMATCH');
    }
    this.#recovery = restored.value;
    this.#state = 'recovering';
    return kok(this.#state);
  }
  /**
   * recovering -> rotation_built. `newKeystore` is a freshly created keystore (new seed) on the new device. The old
   * recovery key signs the key-rotation attestation; the new account key signs the event (signer = new_pubkey).
   */
  async buildRotation(args: { newKeystore: Keystore; oldPubkey: Pubkey; timestamp: IsoUtc }): Promise<KResult<SignedEvent<'KeyRotated'>>> {
    this.#need('recovering');
    const recovery = this.#recovery;
    const recoveryPublicKey = recovery?.identity.recoveryPublicKey ?? null;
    if (recovery === null || recoveryPublicKey === null) return kerr('E_ROLE_UNAVAILABLE', 'recovery');
    const newPubkey = args.newKeystore.identity.accountPublicKey;
    const newCommitment = args.newKeystore.identity.recoveryCommitment;
    const body = { old_pubkey: args.oldPubkey, new_pubkey: newPubkey, new_recovery_commitment: newCommitment };
    const attestation = await recovery.signAttestation('key-rotation', body);
    if (!attestation.ok) return attestation;
    const event = await args.newKeystore.signEvent({
      type: 'KeyRotated', version: 1, signer: newPubkey, timestamp: args.timestamp, prevHash: null,
      payload: { old_pubkey: args.oldPubkey, new_pubkey: newPubkey, recovery_pubkey: recoveryPublicKey, new_recovery_commitment: newCommitment, sig: attestation.value },
    });
    if (!event.ok) return event;
    this.#state = 'rotation_built';
    return kok(event.value as SignedEvent<'KeyRotated'>);
  }
  /** rotation_built -> rotated once the relay returned a receipt; a rejected rotation fails the flow. */
  confirmRotation(accepted: boolean, errorCode = 'REJECTED'): RecoveryState {
    this.#need('rotation_built');
    if (!accepted) { this.#fail(errorCode); return this.#state; }
    this.#recovery?.destroy();
    this.#recovery = null;
    this.#state = 'rotated';
    return this.#state;
  }
  abort(): void {
    wipe(this.#seed);
    this.#seed = null; this.#mnemonic = null;
    this.#recovery?.destroy(); this.#recovery = null;
    this.#state = 'failed';
  }
}
