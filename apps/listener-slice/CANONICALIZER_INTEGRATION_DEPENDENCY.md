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

Required result: BYTE_FOR_BYTE_MATCH

Validated: scoped TypeScript check passed, 12 listener tests passed, and the integrated listener matched the authoritative implementation byte for byte.
