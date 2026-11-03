#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "usage: $0 <path-to-pg-dump>" >&2
    exit 1
fi

DUMP_ARG="$1"

if [[ ! -f "$DUMP_ARG" ]]; then
    echo "error: dump file not found: $DUMP_ARG" >&2
    exit 1
fi

DUMP="$(cd -- "$(dirname -- "$DUMP_ARG")" && pwd)/$(basename -- "$DUMP_ARG")"

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ ! -f .env ]]; then
    echo "error: .env not found in $(pwd)" >&2
    exit 1
fi

COMPOSE=(docker compose -f docker-compose.yml --env-file .env)

read -r -p "Type RESTORE to continue: " CONFIRM
if [[ "$CONFIRM" != "RESTORE" ]]; then
    echo "aborted" >&2
    exit 1
fi

relay_stopped=0

restart_relay_on_exit() {
    local exit_code=$?
    trap - EXIT

    if (( relay_stopped )); then
        if ! "${COMPOSE[@]}" start relay; then
            echo "error: failed to restart relay after restore attempt" >&2
            if (( exit_code == 0 )); then
                exit_code=1
            fi
        fi
    fi

    exit "$exit_code"
}

trap restart_relay_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

relay_stopped=1
"${COMPOSE[@]}" stop relay
"${COMPOSE[@]}" exec -T postgres pg_restore --clean --if-exists --no-owner -U skill -d skill_exchange < "$DUMP"
"${COMPOSE[@]}" start relay
relay_stopped=0

"${COMPOSE[@]}" exec -T relay node -e 'fetch("http://127.0.0.1:3000/v1/health").then(async (r) => { console.log(r.status, await r.text()); if (!r.ok) process.exit(1); }).catch((e) => { console.error(e); process.exit(1); });'
