import type { EventCore, Pubkey, Sig, SignedEvent } from '../../domain/src/protocol.js';
import type { AttestationKind } from '../../crypto/src/index.js';
import { CanonicalError, CryptoInputError, signAttestation, signEvent } from '../../crypto/src/index.js';
import type { ClientResult, EventSigner } from './ports.js';
import { cerr, cok } from './ports.js';

/** Signer over a raw key pair. For tests and tools that already hold the key; apps should use the keystore. */
export function keyPairSigner(identity: { readonly publicKey: Pubkey; readonly privateKey: string }): EventSigner {
  return {
    publicKey: identity.publicKey,
    signEvent: (core: EventCore): Promise<ClientResult<SignedEvent>> => {
      if (core.signer !== identity.publicKey) return Promise.resolve(cerr('SIGNING', 'core.signer is not this signer', 'signer'));
      try { return Promise.resolve(cok(signEvent(core, identity.privateKey))); }
      catch (error) {
        if (error instanceof CanonicalError || error instanceof CryptoInputError) return Promise.resolve(cerr('SIGNING', 'The event could not be signed', 'core'));
        throw error;
      }
    },
    signAttestation: (kind: AttestationKind, body: unknown): Promise<ClientResult<Sig>> => {
      try { return Promise.resolve(cok(signAttestation(kind, body, identity.privateKey))); }
      catch (error) {
        if (error instanceof CanonicalError || error instanceof CryptoInputError) return Promise.resolve(cerr('SIGNING', 'The attestation could not be signed', 'body'));
        throw error;
      }
    },
  };
}

type KeystoreResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };
/** The part of the keystore the client uses (structural, so the client does not depend on the keystore package). */
export interface KeystoreLike {
  readonly identity: { readonly accountPublicKey: Pubkey };
  signEvent(core: unknown): Promise<KeystoreResult<SignedEvent>>;
  signAttestation(kind: unknown, body: unknown): Promise<KeystoreResult<Sig>>;
}

/** Signer over the encrypted keystore; its signing policy (confirmation prompts) stays in force. */
export function keystoreSigner(keystore: KeystoreLike): EventSigner {
  return {
    publicKey: keystore.identity.accountPublicKey,
    signEvent: async (core) => {
      const signed = await keystore.signEvent(core);
      return signed.ok ? cok(signed.value) : cerr('SIGNING', signed.message, signed.code);
    },
    signAttestation: async (kind, body) => {
      const signed = await keystore.signAttestation(kind, body);
      return signed.ok ? cok(signed.value) : cerr('SIGNING', signed.message, signed.code);
    },
  };
}
