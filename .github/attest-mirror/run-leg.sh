#!/usr/bin/env bash
# Runs one attest-mirror leg file with the npm script's own mocha arguments on one xca7 stack; lines UTC-stamped.
set -u
tag=$1
stack=$2
venue_base=$3
leg=$4
shift 4
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=${L004_VENUE_ROOT:?L004_VENUE_ROOT is required}
fed_env=${L004_FED_ENV:-$here/at7.env}
stack_dir=$here/xca7${stack}
log=${L004_LOG_DIR:?L004_LOG_DIR is required}/${tag}.log
venue_logs=$L004_LOG_DIR/venue/${tag}
mkdir -p "$venue_logs"
exec >"$log" 2>&1
: node from PATH
set -a
. "$stack_dir/.env"
set +a
export COIN=bitcoin NETWORK=regtest
export NODE_URL=127.0.0.1 NODE_PORT=$NODE_HOST_PORT NODE_USER=$RPC_USER NODE_PASSWORD=$RPC_PASSWORD
export UTXO_TRACKER_URL=127.0.0.1 UTXO_TRACKER_API_PORT=$TRACKER_HOST_PORT
export ENCODER_URL=127.0.0.1 ENCODER_API_PORT=$ENCODER_HOST_PORT
export DECODER_URL=127.0.0.1 DECODER_API_PORT=$DECODER_HOST_PORT
export DECODER_DB_HOST=127.0.0.1 DECODER_DB_PORT=$DB_HOST_PORT DECODER_DB_NAME=XChain_BTC_Regtest_Decoder DECODER_DB_USER=root DECODER_DB_PASS=$DB_PASSWORD
export INDEXER_URL=127.0.0.1 INDEXER_API_PORT=$INDEXER_HOST_PORT INDEXER_DB_NAME=XChain_BTC_Regtest_Indexer INDEXER_DB_USER=root INDEXER_DB_PASS=$DB_PASSWORD
export DATABASE_URL=127.0.0.1 DATABASE_PORT=$DB_HOST_PORT
export REGTEST_MINER_URL=127.0.0.1 REGTEST_MINER_API_PORT=$MINER_HOST_PORT
export EXPLORER_URL=127.0.0.1 EXPLORER_API_PORT=$EXPLORER_HTTP_HOST_PORT
export HUB_URL=127.0.0.1 HUB_API_HOST=127.0.0.1 HUB_HOST=127.0.0.1 HUB_PORT=$HUB_HOST_PORT
export HUB_DB_HOST=127.0.0.1 HUB_DB_PORT=$DB_HOST_PORT HUB_DB_USER=root HUB_DB_PASS=$DB_PASSWORD
export BTC_SERVICE_HOST=127.0.0.1 BTC_NODE_PORT=$NODE_HOST_PORT BTC_NODE_USER=$RPC_USER BTC_NODE_PASSWORD=$RPC_PASSWORD
export BTC_UTXO_TRACKER_API_PORT=$TRACKER_HOST_PORT BTC_DECODER_API_PORT=$DECODER_HOST_PORT BTC_ENCODER_API_PORT=$ENCODER_HOST_PORT
export BTC_INDEXER_API_PORT=$INDEXER_HOST_PORT BTC_REGTEST_MINER_API_PORT=$MINER_HOST_PORT
export BTC_INDEXER_DB_NAME=XChain_BTC_Regtest_Indexer BTC_INDEXER_DB_USER=root BTC_INDEXER_DB_PASS=$DB_PASSWORD
for C in LTC DOGE; do
    eval "export ${C}_SERVICE_HOST=127.0.0.1"
    eval "export ${C}_NODE_PORT=\$${C}_NODE_HOST_PORT ${C}_UTXO_TRACKER_API_PORT=\$${C}_TRACKER_HOST_PORT"
    eval "export ${C}_DECODER_API_PORT=\$${C}_DECODER_HOST_PORT ${C}_ENCODER_API_PORT=\$${C}_ENCODER_HOST_PORT"
    eval "export ${C}_INDEXER_API_PORT=\$${C}_INDEXER_HOST_PORT ${C}_REGTEST_MINER_API_PORT=\$${C}_MINER_HOST_PORT"
    eval "export ${C}_NODE_USER=\$RPC_USER ${C}_NODE_PASSWORD=\$RPC_PASSWORD"
    eval "export ${C}_INDEXER_DB_USER=root ${C}_INDEXER_DB_PASS=\$DB_PASSWORD"
done
export LTC_INDEXER_DB_NAME=XChain_LTC_Regtest_Indexer DOGE_INDEXER_DB_NAME=XChain_DOGE_Regtest_Indexer
export XCHAIN_VENUE_REPO_ROOT=$root ATTEST_VENUE_LOG_DIR=$venue_logs AB_VENUE_BASE_PORT=$venue_base
[ -f "$fed_env" ] && { set -a; . "$fed_env"; set +a; }
for p in "$BTC_NODE_PORT" "$LTC_NODE_PORT" "$DOGE_NODE_PORT"; do
    if ! curl -fsS --user "$RPC_USER:$RPC_PASSWORD" --data-binary '{"jsonrpc":"1.0","id":"runner","method":"getblockcount","params":[]}' \
        -H 'content-type:text/plain' "http://127.0.0.1:$p/" >/dev/null; then
        printf "runner RPC check failed on port %s for xca7%s\n" "$p" "$stack"; exit 90
    fi
done
cd "${ATTEST_MIRROR_E2E_DIR:-$root/xchain-e2e-test}"
printf "=== leg %s start %s node %s stack xca7%s venue-base %s file %s extra-env [%s]\n" "$tag" "$(date -u +%FT%TZ)" "$(node -v)" "$stack" "$venue_base" "$leg" "$*"
env "$@" npx mocha --timeout 0 --exit --require ./test/initialCheck.test.js "$leg" 2>&1 | node -e 'const rl=require("readline").createInterface({input:process.stdin});rl.on("line",l=>process.stdout.write(new Date().toISOString().slice(11,19)+" "+l+"\n"))'
rc=${PIPESTATUS[0]}
printf "=== leg %s exit=%s end %s\n" "$tag" "$rc" "$(date -u +%FT%TZ)"
exit "$rc"
