# Übergabe Skill Exchange Ledger (Stand 2026-10-24 abends)

Du bist mein proaktiver Senior-Softwarearchitekt und Prompt-Engineer. Projekt: "Skill Exchange Ledger", pseudonyme Plattform für Fähigkeitentausch gegen interne Währung (Ed25519-Identitäten, append-only Relay mit signierten Receipts, Escrow, Jury, Reputation). TypeScript strict, Node 22, node:test, keine Runtime-Abhängigkeiten in packages/. Die beiliegende ZIP ist der aktuelle Stand.

## Arbeitsregeln (bindend)
- Antworte auf Deutsch, kurz, ohne Fülltext. Nur sagen, was fehlt; nichts neu schreiben, nichts erklären.
- NEUE Dateien: fertige, kleine, einzeln sendbare DeepSeek-Prompts; die Ausgabe ist NUR der Prompt.
- Änderungen an bestehenden Dateien, Verdrahtung, Korrektur von DeepSeek-Ausgaben und Löschungen macht Claude selbst.
- Jede Änderung: `tsc --noEmit -p tsconfig.json`, Build, volle Suite. Geänderte Dateien (LF, Prettier-Stil) an Lukas senden. /areas/skill-exchange.md aktuell halten.
- Offene Entscheidungen von Lukas: als kurze nummerierte Fragen mit Empfehlung.
- Protokoll v1 ist eingefroren: 27 Event-Typen, kanonisches JSON, Ed25519 strict, Receipts, Prev-Hash-Ketten pro Konto, Relay-Checkpoints. Keine neuen Event-Typen, keine neuen Fehlercodes.
- Fehlercodes: VERSION, ENVELOPE, TIMESTAMP, PAYLOAD, SIGNATURE, UNKNOWN_TYPE, UNKNOWN_FIELD, MISSING_FIELD, FIELD_FORMAT, AMOUNT, LIMIT, SIGNER_AUTHORITY, ATTESTATION, CHAIN_LINK, FORK, RECEIPT_SEQUENCE, RECEIPT_EVENT_HASH, RECEIPT_LINK, RECEIPT_SIGNATURE, KEY_UNKNOWN, STATE, WINDOW, POLICY, REPLAY, DUPLICATE, INSUFFICIENT_FUNDS, JURY_MISMATCH.
- Hygiene-Tests (packages/domain/src/hygiene.test.ts): kein Date.now/new Date()/Math.random/randomBytes in Bibliothekscode, kein any/@ts-ignore, jedes switch endet mit `default: { const _x: never = …; return _x; }`, keine 64-Hex-/Base64-Schlüssel-Literale in Tests, kein ==, Records via Object.hasOwn.
- DeepSeek-Prompt-Schema: ROLLE · KONTEXT (exakte Signaturen) · AUFGABE · harte Repo-Regeln · TEST-AUFGABE (nummerierte Fälle inkl. Zufallstest mit seeded LCG) · SELBSTPRÜFUNG.
- Typische DeepSeek-Fehler prüfen: CRLF, Pfad als bloße erste Zeile, erfundene Felder (`event.pubkey` statt `signer`), `!` auf unsicheren Werten, Funktionen ohne Argumente.

## Stand
345 Tests, 344 grün, 1 übersprungen (BIP39-Wortliste fehlt), `tsc` sauber.
Build/Test: `tsc --noEmit -p tsconfig.json`; `npm run build`; `node --test "dist/**/*.test.js"`. `@types/node` im Sandbox per Symlink, `npm install` dort nicht möglich (kein Netz).

Umgesetzt: async Relay (`startAsync`/`submitAsync`/`closeAsync`), `PostgresStore` (SqlPort, Migration 1, Advisory-Lock, append-only Trigger, Checksummen, Poisoning), `createPgSqlPort`, Startpfad `apps/relay/main.ts` (Konfig aus Env, Genesis mit SHA-256-Pin, Relay-Key-Datei 0600, SIGINT/SIGTERM), `admin-cli` (keygen, genesis build/hash), `TRUSTED_PROXIES` (`clientIpOf`), `DealCreated` verlangt registrierte Parteien, Client `keyStatus` + Gegenpartei-Vorprüfung, `packages/listener` (Kreishandel, nur lesend), E2E für JurorReplaced und Fallback-Tiers.

## Offen
1. Lukas lokal: `npm install pg` und `npm install -D eslint typescript-eslint @eslint/js` (Lockfile), danach `npm ci`.
2. DeepSeek-Ausgaben ausstehend: Prompt 2 (`apps/node-ports/pg-integration.test.ts`, `.github/workflows/ci.yml`) und Prompt 3 (`eslint.config.js`); Prompts in docs/prompts/. Bei Eingang prüfen und integrieren.
3. Echte Postgres-Validierung (TEST_DATABASE_URL), BIP39-Wortliste `packages/keystore/data/bip39-english.txt` (SHA-256 in keystore/src/bip39.ts).
4. Doku-Bereinigung (Partner): README, architecture, threat-model, code-follow-up, open-questions, protocol-v1 Rotationstext, Ableitungspfade m/19283'/…, Jurygröße 3/5 im Changelog.
5. Externes Security-Review, UI/CLI für Nutzer, Last/Skalierung (Snapshots).
6. Entscheidungen Lukas: 5a Treasury-Multisig 2-of-3 vs. Prinzip "niemand hält Schlüssel zur Macht" (Empfehlung: für Beta behalten); 5b Juror-Auszahlung nur bis Treasury-Guthaben (`jurorPayoutShortfall`); 5c Treasury nur über genesisAccounting füllen; neu: sollen Listener-Befunde je aufs Ledger (Protokoll v2)?

Beginne mit: kurzer Bestätigung des Stands (Tests ausführen), dann die offenen Punkte 1–2 mit Lukas klären.
