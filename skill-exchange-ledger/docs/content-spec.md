# Content package

Scope: content-addressed blob storage, salted commitments and reveals, retention, encrypted transport, precheck port.

- **Store** (`ContentStore`): address = SHA-256 of raw bytes. `MemoryContentStore`, `FsContentStore` (`<root>/aa/bb/<hash>`, temp + fsync + rename, symlinks refused, hash verified on every read, size limit). Hashes are validated against `^[0-9a-f]{64}$` before any path or key exists.
- **Errors**: `UNAVAILABLE` (absent or deleted) is always distinct from `CORRUPT` (bytes do not match their hash).
- **Commitments**: salted kinds use the protocol `commitment(kind, salt32, bytes)`. `precheck-report` uses an empty salt and the plain content hash. Verification happens before storing; a failed reveal stores nothing.
- **Reveal window**: inclusive `[opensAt, closesAt]`; it ends at the appeal deadline.
- **Retention**: deletable strictly after the appeal deadline. Ledger hashes are never touched.
- **Transport (CTP1)**: Ed25519 identities converted to X25519 (RFC 7748 vector and seed/public consistency tests), HKDF-SHA256, ChaCha20-Poly1305, header as AAD. The 12-byte nonce is injected and must never be reused per key pair. With a `Keystore`, the seed never leaves it (`sharedSecretWith`).
- **Precheck**: `PrecheckAdapter` port; `runPrecheck` stores the canonical report and returns only `precheckRef` (for `DeliverableSubmitted.precheck_ref`) and `result`. Informational only.
- Not in this package: moderation (see `moderation-options.md`).
