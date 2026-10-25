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
and byte output.

The repository includes a reproducible compatibility check:

```bash
npx -y tsx apps/listener-slice/scripts/verify-compatibility.mts
```

Required result:

```text
BYTE_FOR_BYTE_MATCH
```

The compatibility script compares the canonical UTF-8 bytes of the unsigned
`RiskFlagged` event, with the `signature` field excluded, between the
integrated and authoritative implementations.

## Authoritative listener snapshot

The authoritative listener reference is included in this repository as an
immutable source snapshot:

```text
authoritative/listener-slice/
```

The snapshot contains only the authoritative listener implementation and its
test crypto adapter. It is kept separate from the production implementation and
does not duplicate the production canonicalizer.

Verify the snapshot contents with:

```bash
cd authoritative/listener-slice
sha256sum -c MANIFEST.sha256
```

Expected result: every listed file reports `OK`.

## Clean-checkout reproduction

From a clean checkout of the pull-request branch, run:

```bash
npm install
npx -y tsx apps/listener-slice/scripts/verify-compatibility.mts
```

The script uses the committed snapshot at
`authoritative/listener-slice/` by default. No local `~/listener-slice`
directory or `AUTHORITATIVE_LISTENER_DIR` environment variable is required.

To validate against a different authoritative checkout, optionally set:

```bash
AUTHORITATIVE_LISTENER_DIR=/path/to/listener-slice \
  npx -y tsx apps/listener-slice/scripts/verify-compatibility.mts
```

Required result:

```text
BYTE_FOR_BYTE_MATCH
```

## Snapshot hashes

The authoritative snapshot was validated on 2026-10-25 with the following
SHA-256 hashes:

```text
2a20cd1481e5fc3de6079e91802c5aac588bc3f1d11fff5c92f9446bd81da3b7  src/crypto-types.ts
05641f44bcacc13467b40c50efba39b46f099e97aefa1a981810a5d2a07861ae  src/crypto.ts
aee6eb1d6f91e05403afde57955111a83b7f00fc156aec273ff50847d401a30a  src/graph.ts
91de4b08807dc7ba2605ec31db5b153aae3727148e9a19dd673b5e69bd1c979f  src/index.ts
2d624a209cd6e0b97b41d4cc3d98a734c9cb02697e5380609279834f94544760  src/riskEvent.ts
771007d07a97fb5e9c18e7923d6a8ca1a8e4b886674f7b685bb21675bb0156f6  src/rules/circularTrading.ts
e6d87ab8e4f5bf9b34193bfb3d8d6e9dd4937bd5010ba5996582fbfa6d7dc189  test/repositoryCryptoAdapter.ts
```

Validated: scoped TypeScript check passed, 12 listener tests passed, and the
integrated listener matched the authoritative snapshot byte for byte.
