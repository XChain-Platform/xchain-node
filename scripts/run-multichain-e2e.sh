#!/usr/bin/env bash
#
# run-multichain-e2e.sh — run the xchain-e2e-test full suite across every chain.
#
# The platform is otherwise validated BTC-only end-to-end. This runs the same
# regtest suite against bitcoin, litecoin and dogecoin so per-chain behavior
# (fee-payment mode, capability-staking being BTC-only, chain quirks) is exercised.
#
# The e2e wiring is already chain-parameterized: `xchain-node e2etest <coin>` builds
# the per-coin stack and the suite resolves its chain from NETWORK=<coin>-regtest
# (xchain-e2e-test/test/initialCheck.test.js splits it into COIN + NETWORK). The
# per-coin regtest node configs (crypto_nodes/<coin>/<coin>-regtest.conf) already
# carry the needed tuning (dogecoin mempool flags, litecoin MWEB-off).
#
# PREREQUISITES (per the local-regtest-stack runbook):
#   - Each coin's stack must be installable/runnable by xchain-node on this host.
#   - Start xchain-node-database before the first install.
#   - Native ext4 data dir (set XCHAIN_NODE_DATA_DIR) — the Parallels share is not safe
#     for bitcoind/litecoind/dogecoind data.
#
# NOTE on exit codes: `xchain-node e2etest` currently prints
#   "E2E tests finished with exit code N"
# but the CLI process itself always exits 0 (see src/cli.js e2etest action —
# `process.exit(0)`). So this runner parses that printed line to determine pass/fail
# rather than trusting $?. RECOMMENDATION: change that CLI line to
# `process.exit(exitCode)` so `xchain-node e2etest` propagates failure natively; this
# runner will then also honor $? as a fallback.
#
# Usage:
#   scripts/run-multichain-e2e.sh                 # all three coins
#   scripts/run-multichain-e2e.sh litecoin dogecoin
#   COINS="bitcoin litecoin" scripts/run-multichain-e2e.sh
#
# Exit status: 0 only if EVERY coin's suite reported exit code 0; non-zero otherwise.

set -uo pipefail

COINS_DEFAULT="bitcoin litecoin dogecoin"
COINS_LIST="${*:-${COINS:-$COINS_DEFAULT}}"

declare -A RESULT
overall=0

for coin in $COINS_LIST; do
    echo "==================================================================="
    echo ">> Running e2e suite for: ${coin} (regtest)"
    echo "==================================================================="

    # Capture combined output so we can parse the reported exit code (the CLI
    # always exits 0 — see note above). tee keeps live output visible.
    out="$(xchain-node e2etest "${coin}" 2>&1 | tee /dev/tty)"
    cli_status=$?

    # Parse "E2E tests finished with exit code N"; fall back to the CLI's own $?.
    reported="$(printf '%s\n' "$out" | sed -n 's/.*finished with exit code \([0-9][0-9]*\).*/\1/p' | tail -1)"
    if [ -z "$reported" ]; then
        reported="$cli_status"
    fi

    RESULT[$coin]="$reported"
    if [ "$reported" != "0" ]; then
        overall=1
    fi
done

echo
echo "==================================================================="
echo "Multi-chain e2e summary"
echo "==================================================================="
for coin in $COINS_LIST; do
    status="${RESULT[$coin]:-?}"
    if [ "$status" = "0" ]; then
        echo "  PASS  ${coin}"
    else
        echo "  FAIL  ${coin}  (exit ${status})"
    fi
done
echo "Per-coin logs: data/e2e-logs/<coin>-regtest-<timestamp>.log"

exit "$overall"
