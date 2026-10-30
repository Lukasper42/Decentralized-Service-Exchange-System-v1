# SkillX (ein Projekt, drei Pakete)

- skill-exchange-ledger/  Ledger, Relay, Listener (Protokoll v1, eingefroren)
- skillx-web/             Browser-UI (Relay-Client, Nachrichten)
- skillx-mailbox/         Postfach-Server für Ende-zu-Ende-Nachrichten

Lizenz: MIT (LICENSE im Wurzelordner und in jedem Paket). CI: .github/workflows/ci.yml (ein Job je Paket, Branch master).

Jedes Paket einzeln: npm install, npm run build, npm test. Alles zusammen im Wurzelordner: npm run build, npm test (Pakete vorher einzeln installieren). Lokal starten:
- Ledger-Relay: siehe skill-exchange-ledger/README.md
- Web-UI: cd skillx-web && npm run build && npm start (http://127.0.0.1:8080)
- Postfach: cd skillx-mailbox && npm run build && ALLOWED_ORIGIN=http://127.0.0.1:8080 npm start

Rauchtests (Browser und echte Prozesse): tools/smoke/README.md (`npm run smoke`).
Listener-Berichte (off-ledger): skill-exchange-ledger/docs/listener-reports.md.
