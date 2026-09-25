#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# bin/ci-full.sh: run EVERY tier this repo's GitHub CI runs, in one process.
#
# .github/workflows/ci.yml fans this repo out as three jobs (ci, drift-guards,
# coverage). The pre-push venue gate used to run only `npm run ci`, so a push
# could gate green locally and then go red on GitHub on a job the gate never
# ran (2026-08-15: exactly that, on three repos at once). This script IS the
# local twin of the workflow: every job's run-steps, transcribed, in job
# order. When ci.yml gains or changes a job, change this script in the same
# commit.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout (.ci-siblings ships them there). A
# sibling a GitHub job checks out is REQUIRED here: missing means fail loud,
# never skip, because GitHub will run the step this gate would be skipping.
#
# All tiers run even after one fails (GitHub reports every red job, so this
# reports every red tier); the exit code is red if any tier was.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SELF="$(pwd)"
SIB="$(cd .. && pwd)"

FAILED=""
# >>> ci-tier (generated block; re-run the tier wirer to update) >>>
# Tier classes. A push grades the FAST tier only: the unit job, the pin and
# drift guards, and the structure and hygiene checks the hook runs before it
# dispatches. The tiers named below (coverage re-runs, perf scenarios) are
# skipped when the gate sets CI_TIER=fast, and each skip is recorded so the
# closing verdict can never claim a green it did not earn. Nothing stops
# being graded: a scheduled sweep re-runs this same script with CI_TIER=full
# on every repo every three hours and before any release or deploy, and a
# red there is tracked down and fixed first. CI_TIER is unset for a hand
# run, so a bare `npm run ci:full` still runs every tier as it always did.
CI_TIER_FULL_ONLY=(
  "coverage ratchet (coverage:check)"
)
DEFERRED=""
ci_tier_deferred() {
  [ "${CI_TIER:-full}" = "fast" ] || return 1
  local t
  for t in ${CI_TIER_FULL_ONLY[@]+"${CI_TIER_FULL_ONLY[@]}"}; do
    if [ "$t" = "$1" ]; then
      DEFERRED="$DEFERRED [$1]"
      echo; echo "ci:full ===== $1 DEFERRED (CI_TIER=fast, runs in the full sweep) ====="
      return 0
    fi
  done
  return 1
}
# <<< ci-tier <<<
# >>> ci-tier timer (generated block; re-run the tier wirer to update) >>>
run_tier() {
  ci_tier_deferred "$1" && return 0  # ci-tier guard (generated)
  local name="$1"; shift
  local __ci_tier_t0=$SECONDS
  echo; echo "ci:full ===== $name ====="
  local root
  root="$(mktemp -d "${TMPDIR:-/tmp}/xchain-node-ci-full.XXXXXX")"
  mkdir -p "$root/config" "$root/data"
  if ( export XCHAIN_NODE_CONFIG_DIR="$root/config" XCHAIN_NODE_DATA_DIR="$root/data"; "$@" ); then
    echo "ci:full ----- $name PASS ($(( SECONDS - __ci_tier_t0 ))s)"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL ($(( SECONDS - __ci_tier_t0 ))s)"
  fi
  rm -rf -- "$root"
}
# <<< ci-tier timer <<<
need_sib() {
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}

# Read the roster ci-reusable.yml's own sibling-checkout step reads
# (.ci-siblings) with the same parse, instead of a second hard-coded
# list the two could drift behind.
CI_SIBLINGS_FILE="$SELF/.ci-siblings"
DECLARED_SIBLINGS=()
if [ -f "$CI_SIBLINGS_FILE" ]; then
  while IFS= read -r s; do
    DECLARED_SIBLINGS+=("$s")
  done < <(sed 's/#.*//' "$CI_SIBLINGS_FILE" | tr -d '\r' | awk 'NF')
fi
if [ "${#DECLARED_SIBLINGS[@]}" -gt 0 ]; then
  need_sib "${DECLARED_SIBLINGS[@]}"
fi

# --- job: ci (XChain-Platform/.github ci-reusable.yml -> npm run ci) -------
# ci-reusable.yml arms XCHAIN_REQUIRE_SIBLINGS whenever it checked
# siblings out, so every sibling guard fails loud on a miss instead of
# skipping; match that here for a true local twin.
if [ "${#DECLARED_SIBLINGS[@]}" -gt 0 ]; then
  run_tier "ci" env XCHAIN_REQUIRE_SIBLINGS=1 npm run ci
else
  run_tier "ci" npm run ci
fi

# --- job: drift-guards -------------------------------------------------------
# Run FROM the parent so sync-coins.sh sees the canonical + vendored pair the
# way the workflow lays them out (hub checkout beside this repo's checkout).
sync_coins_check() { (cd "$SIB" && "xchain-hub/bin/sync-coins.sh" --check --only "$(basename "$SELF")"); }
run_tier "drift: coin-registry byte-identity" sync_coins_check
run_tier "drift: coin consensus-pin conformance" node -e '
  const coins = require("./src/coins");
  for (const net of ["testnet", "regtest"]) {
    const res = coins.verifyConsensusPin(net);
    if (res && res.skipped) throw new Error("consensus pin unexpectedly unarmed for " + net);
  }
  console.log("consensus pin conformance OK (testnet, regtest)");
'

# --- identity pin (also the drift-guards job's identity pin step) ------------
# bin/pins/identity.json holds the sha256 of every vendored coin file. This
# tier re-hashes the tree against it and fails on any moved, missing or
# unreadable file instead of letting the pin go stale.
run_tier "identity pin (vendored coin bytes)" node bin/pin_identity.js --compare bin/pins/identity.json

# --- job: coverage -----------------------------------------------------------
run_tier "coverage ratchet (coverage:check)" env XCHAIN_REQUIRE_SIBLINGS=1 npm run coverage:check

echo
# >>> ci-tier summary (generated) >>>
echo "ci:full: tier class ${CI_TIER:-full}"
if [ -n "${DEFERRED:-}" ]; then
  echo "ci:full: DEFERRED to the full sweep:$DEFERRED"
fi
# <<< ci-tier summary <<<
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
# >>> ci-tier verdict (generated) >>>
if [ "${CI_TIER:-full}" = "fast" ]; then
  echo "ci:full: all FAST tiers green; the DEFERRED tiers above were NOT graded here"
else
  echo "ci:full: all tiers green (same set GitHub CI runs)"
fi
# <<< ci-tier verdict <<<
