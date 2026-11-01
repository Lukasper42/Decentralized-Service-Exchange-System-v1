# SkillX (one project, three packages)

- skill-exchange-ledger/  Ledger, relay, listener (protocol v1, frozen)
- skillx-web/             Browser UI (relay client, messages)
- skillx-mailbox/         Mailbox server for end-to-end encrypted messages

License: MIT (LICENSE in the root folder and in each package). CI: .github/workflows/ci.yml (one job per package, branch master).

Each package on its own: npm install, npm run build, npm test. Everything together in the root folder: npm run build, npm test (install the packages individually first). Run locally:
- Ledger relay: see skill-exchange-ledger/README.md
- Web UI: cd skillx-web && npm run build && npm start (http://127.0.0.1:8080)
- Mailbox: cd skillx-mailbox && npm run build && ALLOWED_ORIGIN=http://127.0.0.1:8080 npm start

Smoke tests (browser and real processes): tools/smoke/README.md (`npm run smoke`).
Listener reports (off-ledger): skill-exchange-ledger/docs/listener-reports.md.
