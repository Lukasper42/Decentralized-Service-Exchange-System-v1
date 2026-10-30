# Listener-Berichte (off-ledger)

Befunde des Circular-Trading-Listeners gehen NICHT aufs Ledger (Entscheidung 6, Protokoll v1 bleibt eingefroren). Sie werden als signierte Berichte an den Relay gesendet, dort geprüft und lokal gespeichert. Es entstehen weder Event-Typen noch Fehlercodes noch Attestation-Arten.

## Bericht (report_version 1)

Felder (alle Pflicht, keine weiteren): `report_version` (1), `rule_id` (`circular-trading-pair`), `account_a`, `account_b` (kanonische Reihenfolge, UTF-8-Bytevergleich, a < b), `forward` und `reverse` je `{deal_id, release_event_hash, sequence, amount, accepted_at}`, `through_sequence`, `through_receipt_hash`, `finding_id`, `listener_pubkey`, `created_at`, `signature`.

- `finding_id` = SHA-256 über kanonisches JSON von Regel, Kontopaar und beiden Release-Hashes. `through_sequence` gehört bewusst nicht dazu, damit derselbe Befund bei späterer Erkennung dieselbe Identität behält.
- Signatur: Ed25519 des Listener-Schlüssels über `skillx/v1/listener-report\n` + kanonisches JSON des Berichts ohne `signature`.
- Berichte enthalten nur Referenzen und Hashes, keine Ledger-Events.

## Endpoint

`POST /v1/reports` (nur wenn aktiviert, sonst 404). Prüfreihenfolge: Form, Allowlist (Schlüssel und Bereich `through_sequence`), `finding_id`, Signatur. Antworten: 201 neu, 200 Duplikat, 400 ungültig, 403 Schlüssel nicht berechtigt, 413/429/503 wie bei `/v1/events`. Gleichzeitige Duplikate werden serialisiert: genau ein 201.

## Aktivierung (Umgebungsvariablen)

- `LISTENER_ALLOWLIST_FILE`: JSON-Array `[{"pubkey","valid_from_sequence","valid_to_sequence"}]`.
- `REPORT_OUTBOX_FILE`: NDJSON-Datei für angenommene Berichte. Beide Variablen müssen zusammen gesetzt sein, sonst bricht der Start ab.
- `REPORT_DELIVERY_URL` (optional): http(s)-Endpoint, der jeden gespeicherten Bericht per POST (JSON) erhält. Ohne sie werden Berichte nur gespeichert.

## Zuverlässigkeit

Erst anhängen, dann zustellen. Unlesbare oder abgeschnittene Zeilen werden beim Laden übersprungen und gefährden die Idempotenz nicht. `<REPORT_OUTBOX_FILE>.done` hält zugestellte oder dauerhaft abgelehnte Berichte fest. Alles andere wird nach einem Neustart erneut zugestellt (at-least-once). Zustellung: 2xx geliefert; 408, 425, 429, 5xx und Netzwerkfehler werden mit exponentiellem Backoff (5 Versuche) wiederholt; andere 4xx sind endgültig; Weiterleitungen werden abgelehnt. Die Empfangsseite muss Duplikate anhand `finding_id` vertragen.

## Grenzen

Der Relay prüft nicht, ob `through_receipt_hash` zur Sequenz passt. Allowlist-Wechsel erfolgen außerhalb des Ledgers (Datei, Neustart nötig).
