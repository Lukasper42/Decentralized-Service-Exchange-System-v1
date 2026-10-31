# Relay specification (Option A: one append-only relay)

Implemented in `packages/relay`. It uses the project's own modules unchanged: `validateEvent` (L1), `verifyChain`,
`applyDealEvent`, receipts and checkpoints from `packages/crypto`. Option B (CometBFT) replaces only the store and the
sequencing step; events, receipts, checkpoints and the state hash stay the same.

## 1. Store port (`LedgerStore`)
`open`, `close`, `append(entry)`, `readRange(from,to)`, `signerTip(signer)`, `findByEventHash(hash)`, `tipSequence`,
`tipEntry`, `all`. An entry is `{ event, receipt }`.

**Atomicity guarantee.** An append either becomes a complete, checksummed, contiguously sequenced record that every later
read observes, or it leaves the store as it was; a torn final record is truncated during recovery and never observed.
After an I/O failure the store is poisoned: it refuses further appends until it is reopened.

- `MemoryStore`: same contract, no durability.
- `FileStore`: one NDJSON file, `<sha256 of canonical json> <canonical json>\n` per entry. Fsync policy `always`
  (default) or `none`. Recovery on open truncates from the first line that is incomplete, fails its checksum, does not
  re-serialize to identical canonical bytes, or breaks sequence contiguity or event binding. The byte-level operations are an
  injectable port, so tests crash the write after every possible byte.

## 2. Submit pipeline (exact order)
1. Size limit on the canonical form (`TOO_LARGE`). 2. L1 `validateEvent` with the relay's receipt time.
3. Idempotency: a known event hash returns the original receipt, nothing is appended.
4. Signer-tip compare-and-append: `prevHash` must equal the signer's tip. A `prevHash` that points at an earlier event of
   the same signer, or a second genesis (`null`), is `FORK`; anything else is `CHAIN_LINK`.
5. L2/L3 projection (`Projector`): signer must be a registered account, invitations (single use), `RelayKeyRotated`
   (approvals, future boundary, no key reuse) and the deal machine. Event types whose projection module is not built yet
   (`AccountInvited`, `KeyRotated`, `ReputationEvent`, `TreasurySpend`, `CurrencyIssued`, `PolicyUpdated`) are rejected with
   `POLICY`: the relay fails closed.
6. Receipt under the relay key in force at the new sequence (`KEY_UNKNOWN` if the operator does not hold it).
7. Durable append. The receipt is returned only after the store confirmed the append; a store failure makes the relay
   read-only (`STORE_FAILURE`). Nothing is written when any step fails.

Sequence assignment, signing and append are one synchronous step, so two callers can never obtain the same sequence.

## 3. Receipts, time, checkpoints, equivocation
- `acceptedAt` comes from the injected clock and is forced non-decreasing, also across restarts.
- A checkpoint exists for every multiple of `checkpointEvery`. Ed25519 is deterministic, so it is recomputed, never stored.
- The relay never signs two receipts for one sequence: the sequence is `tipSequence + 1` taken inside the synchronous
  step, the receipt is released only after a durable append, and a restart recomputes the tip from disk. With fsync `none`
  a crash can lose receipts that clients already hold; that policy is for tests only.
- Relay key rotation: `RelayKeyRotated` (2-of-3 approvals) takes effect at `valid_from_sequence`, which must be later than
  its own receipt. The new private key must be provisioned through the `KeySource` before that sequence, otherwise the relay
  refuses to sign (`KEY_UNKNOWN`) rather than guess.

## 4. Start-up
`start()` opens the store, verifies the complete chain (`verifyChain`) and folds it through the projector. It refuses to
start on any error. `stateHash` is the SHA-256 of the canonical projection state; replaying a ledger twice gives the same hash.

## 5. HTTP API (Node built-ins only)
`POST /v1/events` (body = the signed event; 201 new, 200 duplicate), `GET /v1/tip`, `/v1/entries?from&to` (paged),
`/v1/receipts/:eventHash`, `/v1/signers/:pubkey/tip`, `/v1/checkpoints/latest`, `/v1/health`.
Errors are always `{code, message, path}`. Protocol codes keep their meaning; the transport adds `READ_ONLY` (503),
`RATE_LIMITED` (429), `NOT_FOUND` (404), `BAD_REQUEST` (400), `TOO_LARGE` (413), `STORE_FAILURE` (503).
Body size limit, per-IP and per-signer fixed-window rate limits, strict JSON parsing, no wildcard CORS, no stack traces.

## 6. Known limits
The projector has no balances, jury pool, reputation or versioned policy yet (Prompt 3 modules); the deal context
(policy, funds, jury) is injected. TLS, multi-node consensus and user authentication beyond event signatures are out of scope.
