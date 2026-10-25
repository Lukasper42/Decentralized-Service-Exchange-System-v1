# Prompt 2 für DeepSeek: Postgres-Integrationstest und CI-Workflow (offen, Ausgabe steht aus)

ROLLE
Du bist Senior-TypeScript-/DevOps-Entwickler (strict, Node 22, node:test). Erzeuge genau diese neuen Dateien und gib NUR die Dateien aus, je ein Codeblock; die ERSTE Zeile jeder Datei ist ein Kommentar mit dem Pfad (`// pfad` bzw. `# pfad` in YAML). LF, 2 Leerzeichen.
1. apps/node-ports/pg-integration.test.ts
2. .github/workflows/ci.yml

KONTEXT (bestehend, nicht ändern; Importe mit `.js`-Endung)
- `apps/node-ports/pg-sql-port.ts`: `createPgSqlPort(pool: PgPoolLike): SqlPort` und `pgConnectionOptions(env): { connectionString: string; max: number }`. Der Port hält EINE dedizierte Verbindung (wegen Advisory-Locks), serialisiert alle Aufrufe, `close()` gibt die Verbindung ab und ruft `pool.end()`.
- `packages/relay/src/postgres-store.ts`: `PostgresStore` (`new PostgresStore({ sql, lockKey? })`, `open()`/`append(entry)`/`close()` async, Lese-Methoden `all()`, `tipSequence()` sync, `poisoned`), `SQL`, `MIGRATIONS`, Fehler `StoreError`. Tabelle `ledger_entries` (sequence PK, event_hash UNIQUE, signer, prev_hash, checksum, entry_json), UNIQUE-Indizes pro (signer, prev_hash) und genesis je signer, Trigger `ledger_immutable_trigger` verbietet UPDATE und DELETE, Tabelle `schema_migrations`. Fehler bei Unique-Verstoß haben `code === '23505'`; der Store meldet das als `StoreError('append conflicts with a concurrent writer')`.
- `packages/testing/src/relay-fixtures.ts`: `new RelayRig()`, `rig.bootstrap()`, `rig.openDeal(n)`, `rig.store.all()` liefert gültige `LedgerEntry`-Listen (Beispiel: Einträge erzeugen wie `sampleEntries` in `packages/relay/src/store-crash.test.ts`: `rig.bootstrap(); for (let i = 1; rig.store.all().length < count; i += 1) rig.openDeal(i); return rig.store.all().slice(0, count);`).
- Das Paket `pg` ist in der Typprüfung NICHT vorhanden. Lade es zur Laufzeit dynamisch (`const mod: unknown = await import(name)` mit dem Namen in einer Variablen) und prüfe zur Laufzeit, dass `Pool` ein Konstruktor ist, der `PgPoolLike` liefert (Typen lokal definiert wie in `apps/relay/main.ts`: `type PoolCtor = new (options: { connectionString: string; max: number }) => PgPoolLike`).
- `package.json`-Scripts: `npm ci`, `npm run typecheck`, `npm test` (baut und führt `node --test "dist/**/*.test.js"` aus), `npm run coverage`.

AUFGABE pg-integration.test.ts
Läuft NUR, wenn die Umgebungsvariable `TEST_DATABASE_URL` gesetzt ist; sonst werden alle Tests mit `{ skip: 'TEST_DATABASE_URL is not set' }` übersprungen (genau ein Skip-Grund-Text, keine Fehler). Jeder Test arbeitet in einem eigenen Schema (`CREATE SCHEMA <name>` mit einem Namen aus `process.pid` und einem Zähler, `SET search_path TO <name>` über `port.query` auf der dedizierten Verbindung, am Ende `DROP SCHEMA <name> CASCADE`; Schemanamen nur aus `[a-z0-9_]`), und jeder Test nutzt einen eigenen `lockKey` (Zähler ab 9_000_000).
Fälle (je ein `test`):
1. Migration: `open()` legt `ledger_entries` und `schema_migrations` an, ein zweites `open()` einer neuen Store-Instanz desselben Schemas wendet nichts erneut an (Zeilenzahl in `schema_migrations` bleibt 1).
2. Append und Reload: 4 Einträge anhängen, schließen, neue Instanz öffnen: `all()` liefert dieselben Event-Hashes (`eventHash` aus `../../packages/crypto/src/index.js`), `tipSequence()` ist 4.
3. Append-only: ein direktes `UPDATE ledger_entries SET signer = 'x'` und ein `DELETE FROM ledger_entries` über den Port schlagen mit einem Fehler fehl, dessen Meldung `append-only` enthält; die Daten sind danach unverändert.
4. Unique-Verstoß: zwei Store-Instanzen im selben Schema mit verschiedenen `lockKey`s (der erste Store geöffnet, ein zweiter Port schreibt per `SQL.insertEntry`-artigem Insert dieselbe Sequenz vorab): das `append` des ersten Stores wirft `StoreError` mit `concurrent writer`, der Store ist `poisoned`, `tipSequence()` bleibt unverändert, nach Neuöffnen läuft es weiter.
5. Advisory-Lock: zwei Stores mit DEMSELBEN `lockKey` (zwei getrennte Pools/Ports): das zweite `open()` wirft `StoreError` mit `lock`; nach `close()` des ersten kann das zweite öffnen.
6. Manipulation: `UPDATE` ist per Trigger verboten, also die Zeile im Test über `ALTER TABLE ledger_entries DISABLE TRIGGER ledger_immutable_trigger`, dann Prüfsumme verfälschen, dann Trigger wieder aktivieren; `open()` einer neuen Instanz wirft `corrupt ledger at row 1`, der Advisory-Lock ist danach wieder frei (ein drittes `open()` mit korrigierten Daten funktioniert).
7. Verbindungsabbruch: Nach `SELECT pg_terminate_backend(pg_backend_pid())` auf der dedizierten Verbindung scheitert das nächste `append` mit `StoreError` (I/O failure), der Store ist `poisoned`; mit einer neuen Instanz und neuem Port läuft das Ledger vollständig weiter (kein Eintrag verloren, keiner doppelt).
Die Tests geben nirgends `TEST_DATABASE_URL` oder Passwörter aus (auch nicht in Fehlermeldungen). Aufräumen immer in `finally`.

AUFGABE ci.yml
GitHub-Actions-Workflow `CI` bei `push` auf `main` und bei `pull_request`:
- Job `test` auf `ubuntu-latest`, Node 22 (`actions/setup-node@v4` mit npm-Cache), `services.postgres` mit Image `postgres:16`, Benutzer/Passwort/Datenbank `skill`/`skill`/`skill_exchange_test` (nur CI-Wegwerfwerte), Health-Check (`pg_isready`), Port 5432.
- Schritte: `actions/checkout@v4`, `npm ci`, `npm run typecheck`, `npm test` mit `TEST_DATABASE_URL: postgres://skill:skill@localhost:5432/skill_exchange_test`, danach `npm run coverage` (Ergebnis in die Job-Zusammenfassung schreiben: `>> "$GITHUB_STEP_SUMMARY"`, nur der Text der Coverage-Tabelle, ohne Schwelle).
- Zweiter Job `lint` (nur wenn die Datei `eslint.config.js` existiert, per `hashFiles('eslint.config.js') != ''`): `npm ci`, `npx eslint .`.
- `permissions: contents: read`, `concurrency` pro Ref mit `cancel-in-progress: true`, `timeout-minutes: 15`. Aktions-Versionen als Major-Tags (`@v4`).

HARTE REPO-REGELN
Im Test: kein any/@ts-ignore, kein ==, keine Schlüssel- oder Hash-Literale (zur Laufzeit erzeugen), kein `Math.random`. Typische Fehler vermeiden: CRLF, erste Zeile ohne Kommentar, erfundene Felder oder Funktionen, `!` auf unsicheren Werten.

SELBSTPRÜFUNG
Ohne `TEST_DATABASE_URL` bleibt `npm test` grün (nur Skips); mit gesetzter Variable laufen alle sieben Fälle; `tsc --strict` sauber; YAML gültig; keine Geheimnisse außer den Wegwerf-CI-Werten.
