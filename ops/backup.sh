#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

umask 077

if [[ ! -f .env ]]; then
    echo "error: .env not found in $(pwd)" >&2
    exit 1
fi

read_env() {
    local key="$1"
    awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' .env
}

BACKUP_KEEP="$(read_env BACKUP_KEEP)"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_GPG_RECIPIENT="$(read_env BACKUP_GPG_RECIPIENT)"

if ! [[ "$BACKUP_KEEP" =~ ^[0-9]+$ ]] || (( BACKUP_KEEP < 1 )); then
    echo "error: BACKUP_KEEP must be a positive integer" >&2
    exit 1
fi

install -d -m 0700 backups

TS="$(date -u +%Y%m%dT%H%M%SZ)"
COMPOSE=(docker compose -f docker-compose.yml --env-file .env)

PG_TMP="backups/.pg-${TS}.dump.tmp"
SECRETS_TMP="backups/.secrets-${TS}.tar.gz.tmp"
SECRETS_GPG_TMP="backups/.secrets-${TS}.tar.gz.gpg.tmp"
MAILBOX_TMP="backups/.mailbox-${TS}.json.tmp"

cleanup() {
    rm -f -- "$PG_TMP" "$SECRETS_TMP" "$SECRETS_GPG_TMP" "$MAILBOX_TMP"
}
trap cleanup EXIT

"${COMPOSE[@]}" exec -T postgres pg_dump -U skill -Fc skill_exchange > "$PG_TMP"
mv -- "$PG_TMP" "backups/pg-${TS}.dump"

tar -czf "$SECRETS_TMP" -C . secrets/relay.key secrets/genesis.json
if [[ -n "$BACKUP_GPG_RECIPIENT" ]]; then
    gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" \
        --output "$SECRETS_GPG_TMP" "$SECRETS_TMP"
    mv -- "$SECRETS_GPG_TMP" "backups/secrets-${TS}.tar.gz.gpg"
    rm -f -- "$SECRETS_TMP"
else
    mv -- "$SECRETS_TMP" "backups/secrets-${TS}.tar.gz"
    echo "warning: BACKUP_GPG_RECIPIENT is not set; secrets archive is unencrypted" >&2
fi

if "${COMPOSE[@]}" --profile mailbox ps --status running --services 2>/dev/null | grep -x 'mailbox' >/dev/null; then
    "${COMPOSE[@]}" --profile mailbox exec -T mailbox cat /app/data/mailbox.json > "$MAILBOX_TMP"
    mv -- "$MAILBOX_TMP" "backups/mailbox-${TS}.json"
fi

prune() {
    local pattern="$1"
    local -a old=()
    mapfile -t old < <(
        find backups -maxdepth 1 -type f -name "$pattern" -printf '%T@ %p\n' \
            | sort -nr \
            | awk -v keep="$BACKUP_KEEP" 'NR > keep { print $2 }'
    )
    if (( ${#old[@]} > 0 )); then
        rm -f -- "${old[@]}"
    fi
}

prune 'pg-*.dump'
prune 'secrets-*.tar.gz*'
prune 'mailbox-*.json'

trap - EXIT
cleanup
