/**
 * Stable keystore error codes. Messages are static templates plus non-secret context (a type name, a length);
 * they never contain a key, word, seed or passphrase.
 */
export const KEYSTORE_ERROR_CODES = [
  'E_BAD_INPUT', 'E_BAD_WORDLIST', 'E_BAD_MNEMONIC', 'E_NO_PORT', 'E_UNSUPPORTED_VERSION', 'E_KDF_PARAMS',
  'E_DECRYPT_FAILED', 'E_UNKNOWN_EVENT_TYPE', 'E_UNKNOWN_ATTESTATION_KIND', 'E_SIGNER_MISMATCH',
  'E_ROLE_UNAVAILABLE', 'E_POLICY_DENIED', 'E_STATE', 'E_DESTROYED', 'E_WEAK_PASSPHRASE', 'E_COMMITMENT_MISMATCH',
] as const;
export type KeystoreErrorCode = typeof KEYSTORE_ERROR_CODES[number];

export class KeystoreError extends Error {
  readonly code: KeystoreErrorCode;
  constructor(code: KeystoreErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = 'KeystoreError';
    this.code = code;
  }
}

/** Result type for operations that take untrusted input: they never throw for hostile data. */
export type KResult<T> = { ok: true; value: T } | { ok: false; code: KeystoreErrorCode; message: string };
export const kok = <T>(value: T): KResult<T> => ({ ok: true, value });
export const kerr = <T = never>(code: KeystoreErrorCode, detail?: string): KResult<T> => ({ ok: false, code, message: detail === undefined ? code : `${code}: ${detail}` });
