# skillx-web

Standalone web UI for the SkillX ledger (TypeScript, no runtime dependencies).

## Build
npm install
npm run build   # tsc -> dist/

## Run locally
npm run build
npm start   # node serve.mjs, only 127.0.0.1:8080 (other port: node serve.mjs 9000)
Then open http://127.0.0.1:8080. The server has no dependencies, serves only index.html, styles.css and dist/*.js, and sets security headers. Do not double-click index.html (file:// does not work with ES modules/CSP).

## Tests
npm test   # node:test against dist/**/*.test.js

## Note on relay CORS
The relay must allow CORS for the origin of this UI (GET + POST, application/json).

## Anonymity and security
- The UI cannot hide your IP address: the relay sees IP and access times. Use Tor Browser (ideally with an .onion relay) or a trustworthy VPN.
- Your pseudonym (public key) is public on the chain; all actions can be linked through it.
- Keys: password-encrypted only (PBKDF2-SHA-256 600000 + AES-GCM), password at least 16 characters, lock after 10 minutes.
- Network: https:// only (http:// only for .onion and localhost), no cookies, no referrer, no cache, no redirects.
- CSP: no scripts/styles/images from third parties, `connect-src` only https, .onion and localhost. For a stricter limit, set `connect-src` to your own relay origin, and additionally set HTTP headers (`frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`) on the web server.
- Serve only over HTTPS or locally; a compromised web server could deliver manipulated code.

## Messages (end-to-end, via skillx-mailbox)
- "Messages" view: set the mailbox URL, publish the key bundle, send, fetch the inbox.
- The X25519 messaging key is derived deterministically from the identity (nothing extra to store, recoverable on every device with the same identity).
- The recipient's bundle is checked against their identity pubkey (the server cannot substitute a foreign key).
- History is kept in memory only and is deleted on lock; optionally it can be stored locally, encrypted (PBKDF2 + AES-GCM).
- The mailbox server sees IP and access times: use Tor/VPN.
