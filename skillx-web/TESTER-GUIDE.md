# SkillX beta: tester guide

This is a test version. Do not use real money, real identities or valuables. The ledger can be reset at any time, and nothing here has had an external security review.

## What you can do in the UI
- Create a key and see your public key (your pseudonym).
- Register your key as a ledger account (Account page, "Register this key"). This works only if the operator put your public key into the genesis.
- Create a deal as buyer (Deals page, "New deal"): seller public key, amount, deadline in days, acceptance criteria.
- Browse the chain (Explorer), your account totals and your deals.
- Consent to a deal as seller (Deals, "Consent").
- Fund the escrow as buyer, once the seller has consented (Deals, "Fund escrow").
- Submit a delivery as seller, once escrow is funded (Deals, enter the deliverable text, "Submit deliverable"). Send the same text to the buyer yourself, for example via Messages; only its hash goes on the ledger.
- Accept a delivery as buyer (Deals, "Accept"), or reject it with a reason (Deals, enter a reason, "Reject"). Only a salted hash of the reason goes on the ledger; the text and salt stay in this browser.
- Open a dispute after a rejection, as either buyer or seller (Deals, "Open dispute").
- Vote as an assigned juror (Jury).
- Send and receive end-to-end encrypted messages (Messages), if the operator runs a mailbox.

## What is not in the UI yet
Everything after a dispute is opened (jury assignment, voting as a party, appeals, release) still needs the operator or scripts. The UI covers a deal from creation through fund/deliver/accept-or-reject/dispute.

## First steps
1. Open the address the operator gave you. Use Tor Browser if the address ends in `.onion`.
2. Status: enter the relay URL and the relay public key from the operator, "Save and connect". Expectation: health ok, tip and locally verified length equal.
3. Identity: create a key with a password of at least 16 characters.
4. Identity: export the vault now and keep the file safe.
5. Send the operator your public key (the code line on the Identity page). The operator must list it in the genesis before you can register.
6. After the operator confirms, Account page: "Register this key". Expectation: the button disappears and the Deals page shows the "New deal" form.

## Things that surprise people
- Your acceptance criteria text and its random salt stay only in this browser (only a salted hash goes on the ledger). Clearing site data loses them; the vault export does not contain them.
- In this version your recovery key is the same as your key: there is no separate recovery.
- The UI stores exactly one key per browser. Creating a new key overwrites it. "Delete vault" removes it for good: without the exported vault file and the password there is no recovery.
- Unlocking is lost when you reload the page. Move around with the menu links, not the address bar. The key locks itself after 10 minutes.
- Account totals are derived from ledger entries only. Before your first entry everything shows 0.
- All numbers shown are "derived, not authoritative": the browser verifies the chain itself.
- Console errors starting with "VM..." usually come from password-manager extensions and are harmless. A 404 on `/v1/checkpoints/latest` is normal while no checkpoint exists.
- Deals can be blocked for a stated reason (key locked, chain divergence, relay read-only, last sync failed). The Deals view names the reason.
- The relay sees your IP address and access times. Use Tor Browser or a VPN if that matters to you.
- If the UI reports a rollback or fork, do not click "Reset remembered chain state" before telling the operator.

## Reporting a problem
Send the operator: what you clicked, the exact text shown, the time, and the browser console (F12, Console tab). Never send your password or your vault file.
