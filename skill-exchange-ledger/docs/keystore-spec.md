# Keystore specification (v1)

Implemented in `packages/keystore`. Signatures are produced with the project's own `signEvent` and `signAttestation`,
so they verify with `verifyEvent` / `verifyAttestation` and pass `validateEvent`.

## 1. Seed and derivation
- BIP39 mnemonic (12 words by default, up to 24). The BIP39 passphrase is fixed to the empty string.
- SLIP-0010 for Ed25519, hardened only. Account key `m/19283'/0'/0'`, recovery key `m/19283'/0'/1'`
  (19283 = 0x4B53). Both are derived from the 64-byte seed on demand; only the seed is held in memory.
- The wordlist is a vendored data file with a pinned SHA-256 (`packages/keystore/data/README.md`). The pinned digest is
  verified at load; the file is vendored and the digest was checked.
- Test evidence: the official SLIP-0010 Ed25519 vector 1 and BIP39 TREZOR vector 1 (PBKDF2 part), plus independent
  reference implementations (HMAC chain on hex strings, BigInt bit string) inside the tests.

## 2. Ports
`EntropyPort.bytes(n)`, `ClockPort.nowMs()`, `KeychainPort` (shape only). The library never calls a random source; the
only OS entropy and wall-clock use is `apps/node-ports`.

## 3. Encrypted file
JSON: `format`, `version` 1, `id`, `kdf` (scrypt, parameters and salt stored), `cipher` (AES-256-GCM, iv, tag),
`identity` (account public key, recovery commitment), `ciphertext`. The header is authenticated as AAD. Opened files are
checked against KDF bounds (N 2^10..2^20 power of two, r<=16, p<=4) before any key derivation. A wrong passphrase and a
tampered file give the same `E_DECRYPT_FAILED`. Passphrase minimum length is 8. A file-opened keystore holds only the
account role; the recovery role exists only in a keystore built from the mnemonic.

## 4. Signing API
`signEvent` accepts the 27 protocol event types only and only when `core.signer` is this account.
`EscrowFunded`, `EscrowReleased`, `AppealOpened`, `TreasurySpend`, `CurrencyIssued` and `KeyRotated` need the
`policy.confirm` hook to return true; a missing, denying or throwing hook refuses. `signAttestation` accepts
`deal-consent`, `precheck`, `jury-vote` (account role) and `key-rotation` (recovery role, confirmation required);
`checkpoint` and `treasury-approval` are not signable here. `approve` signs a multisig approval for a governed action and
always needs confirmation. No function exports a seed, private key or plaintext.

## 5. Recovery workflow (`RecoveryFlow`)
`idle -> seed_shown -> verifying -> verified -> active` for creation (words returned once; three random positions are
re-entered; three wrong answers re-show the seed with a new challenge; commit drops the mnemonic).
`idle|active -> recovering -> rotation_built -> rotated|failed` for recovery: the mnemonic must reproduce the recovery
commitment recorded in `AccountCreated`; the old recovery key signs the `key-rotation` attestation, the new device's
account key signs the `KeyRotated` event. Rotation is effective at its receipt sequence and is not retroactive: events
the old key signs before that receipt remain valid. Who wins a race between the legitimate owner and a thief holding the old
key is decided only by receipt order. Wrong words, wrong commitment, a second build, a rejected rotation and abort all end
in refusal.

## 6. Limits (honest)
JavaScript strings (the Base64 private key handed to the crypto module, the mnemonic) cannot be wiped; buffers are wiped
where the runtime allows it. No OS keychain implementation, no biometric unlock, no social recovery.
