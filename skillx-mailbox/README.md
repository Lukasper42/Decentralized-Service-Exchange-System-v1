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

## Running as a Tor onion service
Not tested in the development sandbox (no Tor access). Check with Tor Browser after setup.

1. Install Tor on the server (package `tor`) and add to `/etc/tor/torrc`:

        HiddenServiceDir /var/lib/tor/skillx-mailbox/
        HiddenServiceVersion 3
        HiddenServicePort 80 127.0.0.1:8787

2. Restart Tor. The address is in `/var/lib/tor/skillx-mailbox/hostname` (`<name>.onion`).
3. Start the mailbox with the exact origin the browser uses for the web UI (scheme and host, no path, no trailing slash):

        ALLOWED_ORIGIN=http://<web-ui-name>.onion PORT=8787 npm start

   Serve skillx-web as an onion service as well (same pattern, `HiddenServicePort 80 127.0.0.1:8080`), so that the page and the mailbox are both reached through Tor Browser.
4. In the UI (Messages) enter the mailbox URL `http://<name>.onion` (http:// is accepted for .onion).
5. Check: Tor Browser, `http://<name>.onion/v1/health` returns 200.

Notes:
- Back up `HiddenServiceDir` (the private key there is the address) and `data/mailbox.json`.
- The mailbox stays bound to 127.0.0.1; do not expose its port directly.
- A wrong `ALLOWED_ORIGIN` shows up in the browser console as a CORS error.
- Not covered: delivery spam, and the operator of the Tor host still sees traffic volume.
