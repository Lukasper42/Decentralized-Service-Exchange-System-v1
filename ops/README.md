# SkillX relay deployment

These files deploy the relay, PostgreSQL, the Caddy-served web UI, and the optional mailbox on one Linux server.

## Prerequisites

- DNS `A` and/or `AAAA` records for `${DOMAIN}` and `mailbox.${DOMAIN}` pointing to the server.
- Inbound TCP ports `80` and `443` open. UDP port `443` is used for HTTP/3.
- Docker Engine with the Compose plugin (`docker compose`).

## First start

Run the following commands from the repository root:

```sh
cd ops
cp .env.example .env
```

Edit `.env` and set `DOMAIN`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, and `GENESIS_SHA256`.
Use URL-safe characters for `POSTGRES_PASSWORD`, because it is embedded in `DATABASE_URL` without URL encoding. In this `.env` file, write a literal `$` as `$$`.

Create the secrets directory and place the two files there:

```sh
mkdir -p secrets
# Copy genesis.json and relay.key into ops/secrets/.
chmod 600 secrets/relay.key
chown 1000:1000 secrets/relay.key
sha256sum secrets/genesis.json
```

Copy the printed SHA-256 value into `GENESIS_SHA256` in `.env`. The relay container runs as uid `1000`; the relay refuses a key file readable by group or others, and the container user must own and be able to read it.

Make the scripts executable and start the stack:

```sh
chmod +x backup.sh restore.sh
docker compose --env-file .env up -d --build
```

To include the mailbox, use this command instead of the preceding `up` command:

```sh
docker compose --env-file .env --profile mailbox up -d --build
```

## Verify

Set `DOMAIN` to the public DNS name configured in `.env`, then check the relay health endpoint and open the UI:

```sh
# Replace example.com with the DOMAIN value from .env.
DOMAIN=example.com
curl "https://$DOMAIN/v1/health"
```

The web UI is at `https://$DOMAIN/`. With the mailbox profile enabled, the mailbox is at `https://mailbox.$DOMAIN/`.

## Updating

Run from the repository root:

```sh
git pull
cd ops
docker compose --env-file .env up -d --build
```

When the mailbox profile is enabled, include `--profile mailbox` in the Compose command.

## Backups

Run `./backup.sh` from `ops/`. It writes PostgreSQL dumps and a secrets archive to `ops/backups/`; when the mailbox profile is running, it also copies the mailbox JSON file. It keeps `BACKUP_KEEP` files per backup kind. The secrets archive is unencrypted unless `BACKUP_GPG_RECIPIENT` is set.

Example daily cron entry:

```cron
0 3 * * * cd /path/to/repo/ops && ./backup.sh >> backups/backup.log 2>&1
```

Without `BACKUP_GPG_RECIPIENT`, the script prints a warning because the secrets archive is stored unencrypted. Set a GPG recipient in `.env` to encrypt it.

## Restore test

Test restores on a non-production copy first. From `ops/`, list the available dumps and pass the exact filename you want to restore:

```sh
ls -1t backups/pg-*.dump
./restore.sh "backups/pg-20261102T030000Z.dump"
```

Replace the example filename with one shown by `ls`. Type the literal text `RESTORE` when prompted. The script stops the relay, restores the dump, starts the relay again, and prints the relay health response. It does not touch the secrets.

> **Warning:** The relay key and the genesis file are the identity of the chain. Losing `relay.key` means the chain cannot be continued. The genesis file must never be replaced once a relay has used it.

## Logs

From `ops/`, use:

```sh
docker compose --env-file .env logs relay
```

## Untested

These deployment files were produced without running Docker. Test them on the server before relying on them.

Tor onion operation is out of scope; see `skillx-mailbox/README.md`.
