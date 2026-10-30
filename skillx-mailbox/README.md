# skillx-mailbox

Postfach-Server für das Protokoll `skillx-mailbox v1` (siehe Spezifikation im Prompt/Repo).

Der Server speichert selbst-signierte KeyBundles und Ende-zu-Ende-verschlüsselte Envelopes. Er sieht weder Absender noch Inhalt der Nachrichten und ist kein Ledger-Teilnehmer.

## Start
    npm run build
    ALLOWED_ORIGIN=https://example.org PORT=8787 npm start

- Bindet ausschließlich an 127.0.0.1 (Betrieb hinter Tor-Onion-Service oder Reverse-Proxy).
- Persistenz: data/mailbox.json (atomar über tmp-Datei + rename).
- ALLOWED_ORIGIN ist Pflicht (Access-Control-Allow-Origin).
- Keine Logs mit IP, Pfaden, Headern oder Schlüsseln.

## Skripte
- npm run build: TypeScript kompilieren
- npm test: kompilieren und Tests ausführen
- npm start: Server starten
