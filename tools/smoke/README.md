# Smoke tests

Browser and process tests against the real relay (memory mode), the real mailbox and the built web UI. They complement the
unit tests and catch errors at the seams (CORS, view construction, endpoint activation).

Prerequisites (in the repo root folder):

    npm run build                                  # builds ledger, web and mailbox (install the packages individually first)
    npm i --no-save playwright && npx playwright install chromium

Free ports: 8080 (web UI), 3000 (relay), 8787 (mailbox), 9911 (test sink). Run:

    npm run smoke            # all four one after another
    node tools/smoke/ui.mjs  # individually

| Script | Checks |
| --- | --- |
| ui.mjs | Create key, genesis, sync and chain verification, explorer, unlock, deals, consentDeal, rollback detection, error cases |
| messages.mjs | End-to-end messages across two browser profiles and the mailbox |
| jury.mjs | Dispute with 3 jurors, castVote in the UI, resolution (test genesis with jury thresholds 0, for the test only) |
| reports.mjs | POST /v1/reports against the real relay: 404 without configuration, 201/200, concurrency, restart, corrupted outbox, redelivery |

Output: `OK` or `FAIL` per check; exit code 1 as soon as a check fails. Working files live in a temp folder.
Limits: Chromium only, relay memory mode, jury not with the real beta policy.
