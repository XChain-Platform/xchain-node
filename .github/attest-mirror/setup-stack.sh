#!/usr/bin/env bash
# Bring up one xca7 isolated stack (BTC, LTC and DOGE regtest services) and seed the stack hub's chain config.
set -eu
stack=$1
base=$2
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
dir=$root/xca7${stack}
# Host ports must sit above the kernel ephemeral range (32768 to 60999): a 57xxx base collided with a client socket on 2026-09-17.
case $base in 57730) base=64200 ;; 57760) base=64100 ;; esac
mkdir -p "$dir"
cp "$root/compose.yml" "$dir/compose.yml"
cd "$dir"
umask 077
rpc_secret=$(openssl rand -hex 16)
db_secret=$(openssl rand -hex 16)
printf "%s\n" \
    "RPC_USER=xca7${stack}" \
    "RPC_PASSWORD=$rpc_secret" \
    "DB_PASSWORD=$db_secret" \
    "DB_HOST_PORT=$base" \
    "NODE_HOST_PORT=$((base + 1))" \
    "TRACKER_HOST_PORT=$((base + 2))" \
    "DECODER_HOST_PORT=$((base + 3))" \
    "ENCODER_HOST_PORT=$((base + 4))" \
    "INDEXER_HOST_PORT=$((base + 5))" \
    "MINER_HOST_PORT=$((base + 6))" \
    "EXPLORER_HTTP_HOST_PORT=$((base + 7))" \
    "EXPLORER_HTTPS_HOST_PORT=$((base + 8))" \
    "HUB_HOST_PORT=$((base + 9))" \
    "LTC_NODE_HOST_PORT=$((base + 10))" \
    "LTC_TRACKER_HOST_PORT=$((base + 11))" \
    "LTC_DECODER_HOST_PORT=$((base + 12))" \
    "LTC_ENCODER_HOST_PORT=$((base + 13))" \
    "LTC_INDEXER_HOST_PORT=$((base + 14))" \
    "LTC_MINER_HOST_PORT=$((base + 15))" \
    "DOGE_NODE_HOST_PORT=$((base + 16))" \
    "DOGE_TRACKER_HOST_PORT=$((base + 17))" \
    "DOGE_DECODER_HOST_PORT=$((base + 18))" \
    "DOGE_ENCODER_HOST_PORT=$((base + 19))" \
    "DOGE_INDEXER_HOST_PORT=$((base + 20))" \
    "DOGE_MINER_HOST_PORT=$((base + 21))" > .env
chmod 600 .env
date -u
docker compose -p "xca7${stack}" up -d
# Health is read from docker ps status text, never docker inspect (inspect can print env).
health() {
    docker ps --filter "name=^xca7${stack}-$1-1\$" --format "{{.Status}}"
}
for _ in $(seq 1 180); do
    ok=1
    for svc in hub indexer ltc-indexer doge-indexer miner tracker decoder encoder ltc-miner doge-miner; do
        case "$(health $svc)" in *"(healthy)"*) ;; *) ok=0 ;; esac
    done
    if [ "$ok" = 1 ]; then
        set -a
        . ./.env
        set +a
        node "$root/seed-stack-config.js" "$HUB_HOST_PORT"
        node "$root/wait-indexer-schema.js"
        date -u
        exit 0
    fi
    sleep 2
done
date -u
for svc in hub indexer ltc-indexer doge-indexer; do printf "%s=%s\n" "$svc" "$(health $svc)"; done
printf "health timeout for xca7%s\n" "$stack"
exit 1
