# Listener reports (off-ledger)

Findings of the circular-trading listener do NOT go on the ledger (decision 6; protocol v1 stays frozen). They are sent to the relay as signed reports, validated there and stored locally. No event types, error codes or attestation kinds are added.

## Report (report_version 1)

Fields (all required, no others): `report_version` (1), `rule_id` (`circular-trading-pair`), `account_a`, `account_b` (canonical order, UTF-8 byte comparison, a < b), `forward` and `reverse`, each `{deal_id, release_event_hash, sequence, amount, accepted_at}`, `through_sequence`, `through_receipt_hash`, `finding_id`, `listener_pubkey`, `created_at`, `signature`.

- `finding_id` = SHA-256 over the canonical JSON of the rule, the account pair and both release hashes. `through_sequence` is deliberately not part of it, so the same finding keeps its identity when it is detected later.
- Signature: Ed25519 by the listener key over `skillx/v1/listener-report\n` + the canonical JSON of the report without `signature`.
- Reports contain only references and hashes, no ledger events.

## Endpoint

`POST /v1/reports` (only when enabled, otherwise 404). Check order: shape, allowlist (key and `through_sequence` range), `finding_id`, signature. Responses: 201 new, 200 duplicate, 400 invalid, 403 key not authorized, 413/429/503 as for `/v1/events`. Concurrent duplicates are serialized: exactly one 201.

## Activation (environment variables)

- `LISTENER_ALLOWLIST_FILE`: JSON array `[{"pubkey","valid_from_sequence","valid_to_sequence"}]`.
- `REPORT_OUTBOX_FILE`: NDJSON file for accepted reports. Both variables must be set together, otherwise startup fails.
- `REPORT_DELIVERY_URL` (optional): http(s) endpoint that receives every stored report via POST (JSON). Without it, reports are only stored.

## Reliability

Append first, then deliver. Unreadable or truncated lines are skipped on load and do not endanger idempotency. `<REPORT_OUTBOX_FILE>.done` records reports that were delivered or permanently refused. Everything else is delivered again after a restart (at-least-once). Delivery: 2xx is delivered; 408, 425, 429, 5xx and network errors are retried with exponential backoff (5 attempts); other 4xx are final; redirects are refused. The receiving side must tolerate duplicates by `finding_id`.

## Limits

The relay does not check that `through_receipt_hash` matches the sequence. Allowlist changes happen outside the ledger (file, restart required).
