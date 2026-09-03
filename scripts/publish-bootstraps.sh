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
# publish-bootstraps.sh - create SIGNED bootstrap archives and publish them to
# the sync host, on demand or from cron.
#
# This is the publisher (origin-box) counterpart to the consumer-side serving
# logic in xchain-sync/deploy/sync-bootstraps/ (latest.php + .htaccess, which
# resolve latest.tgz / latest.tgz.sig to the newest archive). It wraps
# `xchain-node bootstrap create` with everything that production needs:
#
#   - Signs each archive inline (XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY) so consumers
#     can verify provenance against the pinned public key.
#   - Refuses an unhealthy source. `bootstrap create` runs a source health gate:
#     a service that is stopped, crash-looping, reporting unhealthy,
#     materially behind its tip, or carrying a durable halt marker (a decoder
#     REORG_HALT row, an uncleared sync_halt) is NOT snapshotted. Such a combo is
#     summarised as SOURCE-UNHEALTHY and the run exits non-zero, leaving the last
#     good archive in place as the newest. This exists because the weekly cron
#     once published a halted litecoin/mainnet decoder as the newest "good"
#     archive, which every "take the latest" path then selected.
#   - Waits out a concurrent xchain-node command rather than losing the run.
#     `bootstrap create` is MUTATING, so any update/reset holds the command lock
#     and every combo fails at once; a create is retried for $LOCK_WAIT_MIN
#     minutes, then reported LOCKED (busy box, not a broken source). The retry
#     is here rather than in the CLI so it works against a pinned fleet too.
#   - Redirects the (large) work + output dirs onto a roomy volume via
#     XCHAIN_NODE_DATA_DIR / XCHAIN_NODE_TMP_DIR - the defaults live under the
#     repo on the small root fs and WILL fill it mid-create otherwise.
#   - Transfers each archive + its .sig to the sync host (scp, origin->sync).
#   - Prunes old archives locally and on the sync host, keeping the newest $KEEP
#     by filename plus the newest $KEEP that are SIGNED (see PRUNE_SCRIPT), so a
#     prune can never evict the archive the sync host advertises as latest.
#   - Forces a republish after a reindex. A `reset` rebuilds a store on a NEW
#     lineage, so every archive already published for that combo describes the
#     old one and restoring it halts a fresh install. The node records those
#     combos and `bootstrap create` clears them, so this run asks
#     `xchain-node bootstrap-republish-due` and pulls due combos into the plan
#     even when the schedule would have dropped them. Trackers are reported and
#     deferred to a --with-trackers run by default (their create means
#     downtime); --force-due-trackers overrides that, --no-forced-due disables
#     the whole mechanism.
#   - flock guard so overlapping cron runs cannot collide.
#
# ┌─ DOWNTIME WARNING ──────────────────────────────────────────────────────┐
# │ `bootstrap create xchain-utxo-tracker` STOPS the tracker container for   │
# │ the full LevelDB tar+gzip (can be hours for large mainnet sets) and      │
# │ restarts it after. decoder/indexer use an online --single-transaction    │
# │ dump (no downtime). Tracker creates are therefore OPT-IN: they only run  │
# │ when you pass --with-trackers (or --trackers-only).                      │
# └─────────────────────────────────────────────────────────────────────────┘
#
# Usage:
#   scripts/publish-bootstraps.sh --all                  # decoder+indexer, every served mainnet combo
#   scripts/publish-bootstraps.sh --all --with-trackers  # + utxo-tracker (DOWNTIME)
#   scripts/publish-bootstraps.sh --trackers-only --all  # only trackers (DOWNTIME)
#   scripts/publish-bootstraps.sh xchain-decoder:litecoin:mainnet   # explicit combo(s)
#   scripts/publish-bootstraps.sh --dry-run --all        # show what would run
#   scripts/publish-bootstraps.sh --all --force-due-trackers  # + republish reindexed trackers now (DOWNTIME)
#   scripts/publish-bootstraps.sh --all --no-forced-due  # schedule only, ignore reindex markers
#
# Combos are <service>:<coin>:<network>. Services: xchain-decoder, xchain-indexer,
# xchain-utxo-tracker. --all auto-detects served combos from the module registry
# via `xchain-node bootstrap-combos`, so a STOPPED or crash-looping combo is still
# planned and reaches the source-health gate (regtest is skipped). Explicit combos
# override --all.
#
# Cron examples (origin box crontab; redirect output to a log):
#   # nightly, no downtime (decoder + indexer only):
#   30 3 * * *  $HOME/xchain-node/scripts/publish-bootstraps.sh --all >> $HOME/.bootstrap-publish/cron.log 2>&1
#   # weekly maintenance window, full set incl. trackers (DOWNTIME):
#   30 4 * * 0  $HOME/xchain-node/scripts/publish-bootstraps.sh --all --with-trackers >> $HOME/.bootstrap-publish/cron.log 2>&1
#
# PREREQUISITES:
#   - The Ed25519 private signing key at $SIGNING_KEY (default below). Without
#     it, archives are created UNSIGNED and the run aborts (override with
#     --allow-unsigned). Pin its public half in xchain-node/src/config/.
#   - Passwordless ssh/scp from this box to $SYNC_HOST.
#   - $STAGE_DIR / $TMP_DIR on a volume with room for ~2x the largest archive.
#   - For decoder/indexer: the MariaDB container running so the root password is
#     sourced non-interactively (the create otherwise prompts and a cron run hangs).
#
set -euo pipefail

# ── Config (override via environment) ─────────────────────────────────────
XCHAIN_NODE_BIN="${XCHAIN_NODE_BIN:-xchain-node}"
SIGNING_KEY="${SIGNING_KEY:-$HOME/.bootstrap-signing/bootstrap_signing_key.pem}"
STAGE_DIR="${STAGE_DIR:-/misc/xchain-bootstrap-out}"   # -> XCHAIN_NODE_DATA_DIR
TMP_DIR="${TMP_DIR:-/misc/xchain-bootstrap-tmp}"        # -> XCHAIN_NODE_TMP_DIR
SYNC_HOST="${SYNC_HOST:-user@your-sync-host}"
SYNC_DIR="${SYNC_DIR:-/misc/backups/bootstraps}"
KEEP="${KEEP:-2}"                                       # archives to retain per combo (local + remote)
LOCK_FILE="${LOCK_FILE:-/tmp/publish-bootstraps.lock}"
LOCK_WAIT_MIN="${LOCK_WAIT_MIN:-30}"                    # minutes to wait out a concurrent xchain-node command (0 = refuse at once)
LOCK_POLL_SEC="${LOCK_POLL_SEC:-30}"                    # seconds between those attempts
TRACKER_SVC="xchain-utxo-tracker"
ALL_SERVICES=(xchain-decoder xchain-indexer xchain-utxo-tracker)
# What a coin or network field may contain. Coin and network names are lowercase
# registry identifiers, so anything else in a listing is not a combo this box can
# publish. Deliberately narrower than "no colons": a listing is read from a file
# on disk and its strings become elements of the publish plan, where a payload
# like `xchain-decoder:bitcoin:testnet; rm -rf /` clears a bare [^:]+ filter.
COMBO_FIELD='[a-z0-9][a-z0-9-]*'

# ── Flags ─────────────────────────────────────────────────────────────────
USE_ALL=0 WITH_TRACKERS=0 TRACKERS_ONLY=0 NO_PUBLISH=0 DRY_RUN=0 ALLOW_UNSIGNED=0
FORCE_DUE=1 FORCE_DUE_TRACKERS=0
declare -a COMBOS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all)            USE_ALL=1 ;;
    --with-trackers)  WITH_TRACKERS=1 ;;
    --trackers-only)  TRACKERS_ONLY=1; WITH_TRACKERS=1 ;;
    --no-publish)     NO_PUBLISH=1 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1 ;;
    --no-forced-due)  FORCE_DUE=0 ;;
    --force-due-trackers) FORCE_DUE_TRACKERS=1 ;;
    --dry-run)        DRY_RUN=1 ;;
    --keep)           KEEP="$2"; shift ;;
    -h|--help)        sed -n '2,94p' "$0"; exit 0 ;;
    -*)               echo "unknown flag: $1" >&2; exit 2 ;;
    *)                COMBOS+=("$1") ;;
  esac
  shift
done

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "FATAL: $*"; exit 1; }

# ── Retention policy ──────────────────────────────────────────────────────
# One policy body, piped to `sh -s` for BOTH the sync host (over ssh) and the
# local stage, so the two sides cannot drift the way the producer and the server
# already did.
#
# Serving resolves "latest" as the newest archive that HAS a paired .sig,
# ordered by the UTC timestamp in the FILENAME (sync host latest.php). A prune
# keyed on mtime that lets unsigned archives occupy retention slots therefore
# deletes the exact file the server advertises: with KEEP=2, two unsigned
# strays (an --allow-unsigned run, an operator drop) fill both slots and the
# newest SIGNED archive goes, leaving consumers a 404 and a forced full resync
# while a perfectly good archive existed a moment earlier. mtime is the wrong
# key besides, because a backfilled or re-uploaded archive carries upload time,
# not its name's timestamp.
#
# So retain the union of the newest KEEP by filename and the newest KEEP that
# are signed. The union is never smaller than the by-name set alone, so this
# deletes no more than a name-keyed prune, it cannot evict the serve target, and
# it still bounds a directory at 2*KEEP archives. That bias matters because
# deletions here fan out to the public web tier by a downstream rsync
# --delete-after.
#
# Never candidates: latest.tgz / latest.tar.gz (the hand-placed manual-publish
# aliases, which the server lets win on their own route) and *.part uploads in
# flight. An empty retention set aborts the directory rather than deleting
# everything in it.
PRUNE_SCRIPT=$(cat <<'PRUNE_EOF'
dir="$1"; keep="$2"
[ -n "$dir" ] && [ -d "$dir" ] || exit 0
case "$keep" in ''|*[!0-9]*) exit 0 ;; esac
[ "$keep" -ge 1 ] || exit 0
cd "$dir" || exit 0

all=$(ls -1 ./*.tar.gz 2>/dev/null | sed 's#^\./##' | grep -v '^latest\.tar\.gz$' | LC_ALL=C sort -r)
[ -n "$all" ] || exit 0

signed=$(printf '%s\n' "$all" | while IFS= read -r f; do
           [ -f "$f.sig" ] && printf '%s\n' "$f"
         done)
retain=$({ printf '%s\n' "$all" | head -n "$keep"
           [ -n "$signed" ] && printf '%s\n' "$signed" | head -n "$keep"
         } | sed '/^$/d' | LC_ALL=C sort -u)

# With candidates present, an empty retention set can only mean the selection
# above failed, and "retain nothing" here means "delete every archive".
[ -n "$retain" ] || { echo "  PRUNE ABORTED in $dir: empty retention set, nothing deleted"; exit 0; }

printf '%s\n' "$all" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  printf '%s\n' "$retain" | grep -q -x -F -- "$f" && continue
  rm -f -- "$f" "$f.sig" "$f.sha256"
done

left=$(printf '%s\n' "$retain" | while IFS= read -r f; do
         [ -n "$f" ] && [ -f "$f.sig" ] && printf '%s\n' "$f"
       done | wc -l | tr -d ' ')
if [ "$left" -gt 0 ]; then
  echo "  prune: $left signed archive(s) retained in $dir"
else
  echo "  PRUNE WARNING: no signed archive remains in $dir; the latest endpoint 404s there"
fi
PRUNE_EOF
)

# ── Preconditions ─────────────────────────────────────────────────────────
command -v "$XCHAIN_NODE_BIN" >/dev/null || die "xchain-node CLI not found ($XCHAIN_NODE_BIN)"
if [ ! -f "$SIGNING_KEY" ]; then
  [ "$ALLOW_UNSIGNED" = 1 ] || die "signing key not found: $SIGNING_KEY (use --allow-unsigned to publish unsigned)"
  log "WARNING: no signing key - archives will be UNSIGNED (--allow-unsigned)"
fi
mkdir -p "$STAGE_DIR" "$TMP_DIR" 2>/dev/null || die "cannot create STAGE_DIR/TMP_DIR (need writable $STAGE_DIR and $TMP_DIR)"

# ── Resolve combos ────────────────────────────────────────────────────────
# Auto-detect served combos from the module REGISTRY, not from live containers.
# This used to run `docker ps`, which lists only RUNNING containers, so a stopped
# or crash-looping combo was dropped from the plan before the source-health
# gate could report it: the cron then exited 0 while that consumer's archive went
# missing or increasingly stale, the exact outcome the gate exists to prevent
# (uuid:d0cfcba9). `bootstrap-combos` reads the modules table, whose rows survive
# a stop, so every installed combo enters the plan and an unhealthy one is refused
# loudly instead of vanishing. regtest is skipped there, not here.
detect_combos() {
  local svc_pattern
  svc_pattern="$(IFS='|'; echo "${ALL_SERVICES[*]}")"
  "$XCHAIN_NODE_BIN" bootstrap-combos 2>/dev/null \
    | grep -E "^($svc_pattern):$COMBO_FIELD:$COMBO_FIELD$" \
    | sort -u
}

if [ "${#COMBOS[@]}" -eq 0 ]; then
  [ "$USE_ALL" = 1 ] || die "no combos given. Pass <service>:<coin>:<network> args or --all."
  mapfile -t COMBOS < <(detect_combos)
  [ "${#COMBOS[@]}" -gt 0 ] || die "--all detected no served combos. Check that the MariaDB container is up and that '$XCHAIN_NODE_BIN bootstrap-combos' runs (it needs an xchain-node carrying that subcommand)."
fi

# ── Forced republishes after a reindex ────────────────────────────────────
# A `reset` wipes a store and rebuilds it on a NEW lineage, so from that moment
# every archive already published for that combo describes the OLD one: a fresh
# install that takes it restores pre-reindex state and halts. No age check
# catches that, because the wrong archive is hours old and perfectly fresh.
#
# The node records those combos (`xchain-node bootstrap-republish-due`) and
# `bootstrap create` clears them, so a due combo is one whose newest published
# archive predates its last reindex. Due combos are pulled into the plan even
# when the schedule would have dropped them, which is the only thing that turns
# "the operator remembers to republish" into a forcing function.
#
# Trackers are the exception BY DEFAULT: their create stops the container, and a
# nightly cron must not take the tracker down on its own initiative. A due
# tracker is reported loudly on every run instead and republished by the weekly
# --with-trackers run; --force-due-trackers overrides that for an operator who
# wants the downtime now. --no-forced-due disables the whole mechanism.
declare -a DUE=()
detect_due() {
  local svc_pattern
  svc_pattern="$(IFS='|'; echo "${ALL_SERVICES[*]}")"
  "$XCHAIN_NODE_BIN" bootstrap-republish-due 2>/dev/null \
    | grep -E "^($svc_pattern):$COMBO_FIELD:$COMBO_FIELD$" \
    | sort -u
}
if [ "$FORCE_DUE" = 1 ]; then
  mapfile -t DUE < <(detect_due)
  if [ "${#DUE[@]}" -gt 0 ]; then
    log "reindexed since their last publish (${#DUE[@]}): ${DUE[*]}"
  fi
fi

is_due() {
  local want="$1" d
  for d in ${DUE+"${DUE[@]}"}; do [ "$d" = "$want" ] && return 0; done
  return 1
}

in_list() {
  local want="$1"; shift
  local x
  for x in "$@"; do [ "$x" = "$want" ] && return 0; done
  return 1
}

# Apply tracker policy. A due combo overrides a skip: that is the forcing.
declare -a SELECTED=() DEFERRED_DUE=()
for c in "${COMBOS[@]}"; do
  svc="${c%%:*}"
  if [ "$svc" = "$TRACKER_SVC" ]; then
    if [ "$WITH_TRACKERS" != 1 ]; then
      if is_due "$c" && [ "$FORCE_DUE_TRACKERS" = 1 ]; then
        log "FORCED (reindexed since last publish; overrides the tracker opt-in, DOWNTIME): $c"
      elif is_due "$c"; then
        log "DUE but DEFERRED (tracker create means downtime): $c"
        DEFERRED_DUE+=("$c")
        continue
      else
        log "skip (tracker, needs --with-trackers): $c"; continue
      fi
    fi
  else
    if [ "$TRACKERS_ONLY" = 1 ]; then
      if is_due "$c"; then
        log "FORCED (reindexed since last publish; overrides --trackers-only): $c"
      else
        log "skip (non-tracker, --trackers-only): $c"; continue
      fi
    fi
  fi
  SELECTED+=("$c")
done

# A due combo that the resolved plan never contained at all (explicit combos on
# the command line, or a registry that no longer lists it) still has a wrong
# archive standing as newest, so pull it in too, under the same tracker rule.
for d in ${DUE+"${DUE[@]}"}; do
  in_list "$d" ${SELECTED+"${SELECTED[@]}"} && continue
  in_list "$d" ${DEFERRED_DUE+"${DEFERRED_DUE[@]}"} && continue
  if [ "${d%%:*}" = "$TRACKER_SVC" ] && [ "$WITH_TRACKERS" != 1 ] && [ "$FORCE_DUE_TRACKERS" != 1 ]; then
    log "DUE but DEFERRED (tracker create means downtime): $d"
    DEFERRED_DUE+=("$d")
    continue
  fi
  log "FORCED (reindexed since last publish; not in the resolved plan): $d"
  SELECTED+=("$d")
done

warn_deferred_due() {
  [ "${#DEFERRED_DUE[@]}" -gt 0 ] || return 0
  log "WARNING: ${#DEFERRED_DUE[@]} combo(s) were reindexed and are still serving a PRE-reindex archive:"
  local d
  for d in "${DEFERRED_DUE[@]}"; do log "    $d"; done
  log "  A restore of that archive puts a fresh install on the old lineage, which is how it halts."
  log "  Republish at the next maintenance window (tracker creates mean downtime):"
  log "    $0 --with-trackers ${DEFERRED_DUE[*]}"
}
warn_deferred_due

[ "${#SELECTED[@]}" -gt 0 ] || die "no combos selected after tracker policy."

log "publish plan (${#SELECTED[@]}): ${SELECTED[*]}"
[ "$WITH_TRACKERS" = 1 ] && log "NOTE: tracker creates STOP the tracker container (downtime) for the compress."
if [ "$DRY_RUN" = 1 ]; then log "dry-run: nothing executed."; exit 0; fi

# ── Single-instance lock (cron-safe) ──────────────────────────────────────
exec 9>"$LOCK_FILE"
flock -n 9 || die "another publish run holds $LOCK_FILE - exiting."

# ── Per-combo: create -> verify signed -> publish -> prune ────────────────
fail=0; declare -a SUMMARY=()
for c in "${SELECTED[@]}"; do
  svc="${c%%:*}"; rest="${c#*:}"; coin="${rest%%:*}"; net="${rest##*:}"
  out_dir="$STAGE_DIR/$coin/$net/$svc/bootstrap"
  log "=== $svc $coin $net ==="

  # Capture the create output so a source-health REFUSAL is reported as its own
  # outcome rather than being flattened into a generic CREATE-FAIL. The
  # two need different operator responses: a refusal means the SERVICE is broken
  # (and the last good archive correctly stays newest), a create-fail means the
  # publish machinery is broken.
  # The wait for a lock holder lives HERE, not in the CLI, so it works against
  # any CLI the box happens to carry (a fleet pinned to a release predates the
  # CLI-side wait). XCHAIN_NODE_MUTATING_LOCK_WAIT_MS is pinned to 0 so a newer
  # CLI does not also wait and multiply the budget.
  lock_deadline=$(( $(date +%s) + LOCK_WAIT_MIN * 60 ))
  while : ; do
    create_log="$(mktemp)"
    create_rc=0
    XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY="$SIGNING_KEY" \
    XCHAIN_NODE_DATA_DIR="$STAGE_DIR" \
    XCHAIN_NODE_TMP_DIR="$TMP_DIR" \
    XCHAIN_NODE_MUTATING_LOCK_WAIT_MS=0 \
    "$XCHAIN_NODE_BIN" bootstrap create "$svc" "$coin" "$net" >"$create_log" 2>&1 || create_rc=$?
    if [ "$create_rc" = 0 ]; then break; fi
    if ! grep -q 'holds the command lock' "$create_log"; then break; fi
    if [ "$(date +%s)" -ge "$lock_deadline" ]; then break; fi
    log "  locked by another xchain-node command; retrying in ${LOCK_POLL_SEC}s (budget ${LOCK_WAIT_MIN}m)"
    rm -f "$create_log"
    sleep "$LOCK_POLL_SEC"
  done
  cat "$create_log"
  if [ "$create_rc" != 0 ]; then
    # Contention is neither a broken publisher nor a broken source: the box was
    # busy. Name it so, or CREATE-FAIL sends the operator hunting a fault that
    # does not exist.
    if grep -q 'holds the command lock' "$create_log"; then
      log "  LOCKED: $c - another xchain-node command still held the command lock after ${LOCK_WAIT_MIN}m. Nothing published; the previous archive stays newest."
      SUMMARY+=("$c: LOCKED")
    elif grep -q 'Refusing to create a bootstrap' "$create_log"; then
      log "  REFUSED: $c source is not known-good (reasons above). Nothing published; the previous archive stays newest."
      SUMMARY+=("$c: SOURCE-UNHEALTHY")
    else
      log "  create FAILED for $c"
      SUMMARY+=("$c: CREATE-FAIL")
    fi
    rm -f "$create_log"; fail=1; continue
  fi
  rm -f "$create_log"

  archive="$(ls -t "$out_dir"/*.tar.gz 2>/dev/null | head -1 || true)"
  [ -n "$archive" ] || { log "  no archive produced in $out_dir"; SUMMARY+=("$c: NO-ARCHIVE"); fail=1; continue; }
  if [ ! -f "$archive.sig" ] && [ "$ALLOW_UNSIGNED" != 1 ]; then
    log "  archive is UNSIGNED ($archive) - not publishing"; SUMMARY+=("$c: UNSIGNED"); fail=1; continue
  fi

  if [ "$NO_PUBLISH" = 1 ]; then
    log "  created (not published): $(basename "$archive")"; SUMMARY+=("$c: CREATED-LOCAL");
  else
    dest="$SYNC_DIR/$svc/$coin/$net"
    ssh -o BatchMode=yes "$SYNC_HOST" "mkdir -p '$dest'" || { log "  remote mkdir failed"; SUMMARY+=("$c: PUBLISH-FAIL"); fail=1; continue; }
    files=("$archive")
    [ -f "$archive.sig" ]    && files+=("$archive.sig")
    [ -f "$archive.sha256" ] && files+=("$archive.sha256")
    a_base="$(basename "$archive")"

    # Atomic publish. Upload every file under a `.part` temp name that no
    # `*.tar.gz` consumer glob can match, then rename into place on the sync
    # host with `mv` - sidecars (.sig/.sha256) FIRST, the archive LAST - so the
    # moment an archive is visible under its final name its signature already
    # exists. Consumers resolve "newest" by globbing `*.tar.gz`, so streaming an
    # archive under its final name (as before) exposed a truncated, not-yet-
    # signed file for the whole multi-GB transfer window, and a dead scp left
    # that truncated file shadowing the last good archive. With temp-name+mv, a
    # partial upload only ever exists as a `.part` file and is cleaned up.
    cleanup_parts() {
      local rm_cmd="cd '$dest'"
      local f
      for f in "${files[@]}"; do rm_cmd="$rm_cmd; rm -f '$(basename "$f").part'"; done
      ssh -o BatchMode=yes "$SYNC_HOST" "$rm_cmd" || true
    }

    scp_ok=1
    for f in "${files[@]}"; do
      if ! scp -o BatchMode=yes "$f" "$SYNC_HOST:$dest/$(basename "$f").part"; then scp_ok=0; break; fi
    done
    if [ "$scp_ok" != 1 ]; then
      cleanup_parts
      log "  scp FAILED"; SUMMARY+=("$c: PUBLISH-FAIL"); fail=1; continue
    fi

    # Rename sidecars first, the archive last (single ssh; each mv is atomic
    # within the destination directory). `&&` chains so a mid-rename failure
    # stops before the archive is exposed.
    mv_cmd="cd '$dest'"
    for f in "${files[@]}"; do
      bn="$(basename "$f")"
      [ "$bn" = "$a_base" ] && continue   # archive is renamed last, below
      mv_cmd="$mv_cmd && mv -f '$bn.part' '$bn'"
    done
    mv_cmd="$mv_cmd && mv -f '$a_base.part' '$a_base'"

    if ssh -o BatchMode=yes "$SYNC_HOST" "$mv_cmd"; then
      log "  published $a_base (+sig) to $SYNC_HOST:$dest"
      SUMMARY+=("$c: PUBLISHED")
      # Prune remote under the shared retention policy (see PRUNE_SCRIPT).
      printf '%s\n' "$PRUNE_SCRIPT" | ssh -o BatchMode=yes "$SYNC_HOST" "sh -s -- '$dest' '$KEEP'" || log "  (remote prune warning)"
    else
      cleanup_parts
      log "  publish rename FAILED"; SUMMARY+=("$c: PUBLISH-FAIL"); fail=1; continue
    fi
  fi

  # Prune the local stage under the SAME policy, to bound disk use.
  printf '%s\n' "$PRUNE_SCRIPT" | sh -s -- "$out_dir" "$KEEP" || true
done

log "── summary ──"
for s in "${SUMMARY[@]}"; do log "  $s"; done
warn_deferred_due
[ "$fail" = 0 ] && log "all selected combos OK" || log "one or more combos FAILED"
exit "$fail"
