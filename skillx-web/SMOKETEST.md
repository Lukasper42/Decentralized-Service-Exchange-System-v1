# Rauchtest skillx-web gegen echten Relay (lokal, Windows/PowerShell)

Voraussetzung: Node 22, `npm install` in skill-exchange-ledger und skillx-web.
Relay im Speicher-Modus (RELAY_MODE=memory): nach Neustart ist alles weg.

## A. Relay vorbereiten (Ordner skill-exchange-ledger)
1. `npm run build`
2. Relay-Schlüssel: `node dist/apps/relay/admin-cli.js keygen --out relay.key` (Ausgabe `public_key=...` merken; relay.key nicht einchecken)
3. Web-UI starten (Schritt B), im Reiter Identität drei Schlüssel erzeugen (A, B, C) und öffentliche Schlüssel notieren.
4. genesis-config.json anlegen (Felder: policyId, multisigMembers, inviters, genesisAccounts, checkers, issuancePolicyIds, jurorPayoutPerCase, limits{maxIssuancePerEvent,maxTreasurySpendPerEvent,maxDealAmount}, treasury, grants[{recipient,amount,nonce}]). Konten A und B in genesisAccounts, je ein Grant (z. B. 1000), multisigMembers: 3 Schlüssel. Werte/Grenzen prüft `genesis build`; Fehlermeldung zeigt das Feld.
5. `node dist/apps/relay/admin-cli.js genesis build --config genesis-config.json --relay-public-key <public_key> --out genesis.json` (gibt GENESIS_SHA256 aus)
6. Relay starten:
   ```
   $env:RELAY_MODE="memory"; $env:GENESIS_FILE="./genesis.json"; $env:GENESIS_SHA256="<hash>"
   $env:RELAY_KEY_FILE="./relay.key"; $env:ALLOWED_ORIGIN="http://127.0.0.1:8080"; $env:PORT="3000"
   npm start
   ```
7. Erwartung: Relay läuft auf 127.0.0.1:3000, `curl http://127.0.0.1:3000/v1/health` liefert 200.

## B. Web-UI (Ordner skillx-web)
`npm run build; npm start` -> http://127.0.0.1:8080 (nicht file://)

## C. Prüfpunkte (jeweils Ergebnis notieren: ok / Fehler + Text)
1. Status: Relay-URL http://127.0.0.1:3000 und gepinnten Relay-Pubkey (`public_key=` aus keygen, 44 Bytes SPKI Base64) eintragen, "Speichern und verbinden". Health ok, Tip und lokal verifizierte Länge gleich.
2. Sync: Kette verifiziert ohne Fehler, Pin gesetzt. Relay neu starten (Speicher leer) -> UI meldet Rollback/Fork; Reset-Button löscht den Pin.
3. Identität: Schlüssel erzeugen, Passwort >= 16 Zeichen; sperren, entsperren, falsches Passwort wird abgelehnt; nach 10 Min Auto-Sperre (optional).
4. Konto: Genesis-Grant erscheint als erhalten (abgeleitet, nicht autoritativ).
5. Explorer: Einträge blätterbar, Hashes sichtbar.
6. Deal: DealCreated (Betrag >= 2) mit Konto A/B per Relay-Admin oder Test-Client anlegen; in Deals-Ansicht sichtbar.
7. consentDeal: Schlüssel entsperren, in Deals beim Deal als Verkäufer "Zustimmen" (Zustand wechselt auf zugestimmt) -> Eintrag erscheint, Kette bleibt verifiziert.
8. castVote: nur sinnvoll mit zugewiesener Jury; sonst überspringen und notieren.
9. Fehlerfälle: falsche Relay-URL (http://example.com wird abgelehnt), Relay aus (verständliche Meldung), ALLOWED_ORIGIN falsch (CORS-Fehler sichtbar).
10. Nachrichten (optional, zweiter Terminal): skillx-mailbox mit `$env:ALLOWED_ORIGIN="http://127.0.0.1:8080"; npm start`; Postfach-URL setzen, Schlüsselbündel veröffentlichen, an zweite Identität senden, abrufen.

## D. Bereits in der Sandbox geprüft (2026-10-29, Chromium, Relay im Speicher-Modus)
C1-C7 und C9 ok (Status/Sync, Explorer, Entsperren inkl. falschem Passwort, Konto, Deals, consentDeal, Rollback-Erkennung nach Relay-Neustart, Pin-Reset, Relay aus, http://example.com abgelehnt). Dabei gefunden und behoben: Relay beantwortete CORS-Preflight (OPTIONS) nicht, daher scheiterte jedes POST aus dem Browser; Ansichten blieben bis zum nächsten Poll (15 s) leer. C10 (Nachrichten, zwei Browser-Profile, Mailbox auf 127.0.0.1:8787) ok: Schlüsselbündel, Senden, Entschlüsseln, Löschen, unbekannter Empfänger gibt "Senden fehlgeschlagen.". castVote ok mit Test-Genesis (Jury-Schwellen auf 0, nur für den Test): Streitfall, 3 Juroren (einer davon die UI), Abstimmung in der UI, Auflösung 2:1. Mit der echten Beta-Policy (20 Deals, 5 Gegenparteien, 60 Tage) nicht geprüft. Nicht geprüft: Windows/echter Browser.

## E. Ergebnis
Pro Punkt ok/Fehler, bei Fehler: Konsole (F12) und Relay-Ausgabe an Claude schicken.
