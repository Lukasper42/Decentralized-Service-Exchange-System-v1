# skillx-mailbox

Mailbox server for the `skillx-mailbox v1` protocol.

The server stores self-signed key bundles and end-to-end encrypted envelopes. It sees neither the sender nor the content of messages and is not a ledger participant.

## Start
    npm run build
    ALLOWED_ORIGIN=https://example.org PORT=8787 npm start

- Binds to 127.0.0.1 only (run behind a Tor onion service or a reverse proxy).
- Persistence: data/mailbox.json (atomic via temp file + rename).
- ALLOWED_ORIGIN is required (Access-Control-Allow-Origin).
- No logs containing IPs, paths, headers or keys.

## Scripts
- npm run build: compile TypeScript
- npm test: compile and run the tests
- npm start: start the server
