# Canonicalizer integration dependency

## Status

The canonicalizer is a **load-bearing integration dependency** for the
circular-trading listener slice.

The listener emits a signed `RiskFlagged` event. Its signature and downstream
verification depend on the exact canonical byte serialization of that event.
A semantically equivalent but differently ordered or formatted JSON object is
not acceptable: it can invalidate the signature and break event-chain
verification.

## Integrated implementation

The listener-slice uses the repository’s canonicalizer:

- `packages/crypto/src/index.js` — exports `canonical`
- `apps/listener-slice/src/index.js` — emits the signed event
- `apps/listener-slice/test/repositoryCryptoAdapter.js` — repository crypto adapter

The canonicalizer is used to serialize the signed event before signature
generation and verification.

## Authoritative parity

The authoritative listener implementation remains the reference for behavior
and byte output:

- `~/listener-slice/src/crypto.ts` — authoritative `canonical`
- `~/listener-slice/src/index.ts` — authoritative `runListener`
- `~/listener-slice/test/repositoryCryptoAdapter.ts` — authoritative adapter

The repository includes a reproducible parity check:

```bash
AUTHORITATIVE_LISTENER_DIR=~/listener-slice \
  npx -y tsx apps/listener-slice/scripts/verify-compatibility.mts
```

Required result: `BYTE_FOR_BYTE_MATCH`

The compatibility script compares the canonical UTF-8 bytes of the unsigned
`RiskFlagged` event, with the `signature` field excluded, between the
integrated and authoritative implementations.

## Authoritative listener source identity

The authoritative listener implementation is not maintained in a Git repository
in the local validation environment. Its source files were identified by
SHA-256 hashes at validation time:

- `src/crypto.ts`: `05641f44bcacc13467b40c50efba39b46f099e97aefa1a981810a5d2a07861ae`
- `src/index.ts`: `91de4b08807dc7ba2605ec31db5b153aae3727148e9a19dd673b5e69bd1c979f`
- `test/repositoryCryptoAdapter.ts`: `e6d87ab8e4f5bf9b34193bfb3d8d6e9dd4937bd5010ba5996582fbfa6d7dc189`

Validation date: 2026-10-24

Validated: scoped TypeScript check passed, 12 listener tests passed, and the
integrated listener matched the authoritative implementation byte for byte.
