#!/usr/bin/env bash
#
# publish-bootstraps.sh — create SIGNED bootstrap archives and publish them to
# the sync host, on demand or from cron.
#
# This is the publisher (origin-box) counterpart to the consumer-side serving
# logic in xchain-sync/deploy/sync-bootstraps/ (latest.php + .htaccess, which
# resolve latest.tgz / latest.tgz.sig to the newest archive). It wraps
# `xchain-node bootstrap create` with everything that production needs:
#
#   - Signs each archive inline (XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY) so consumers
#     can verify provenance against the pinned public key.
#   - Redirects the (large) work + output dirs onto a roomy volume via
#     XCHAIN_NODE_DATA_DIR / XCHAIN_NODE_TMP_DIR — the defaults live under the
#     repo on the small root fs and WILL fill it mid-create otherwise.
#   - Transfers each archive + its .sig to the sync host (scp, origin->sync).
#   - Prunes old archives locally and on the sync host (keep newest $KEEP).
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
#
# Combos are <service>:<coin>:<network>. Services: xchain-decoder, xchain-indexer,
# xchain-utxo-tracker. --all auto-detects served combos from running containers
# (regtest is skipped). Explicit combos override --all.
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
TRACKER_SVC="xchain-utxo-tracker"
ALL_SERVICES=(xchain-decoder xchain-indexer xchain-utxo-tracker)

# ── Flags ─────────────────────────────────────────────────────────────────
USE_ALL=0 WITH_TRACKERS=0 TRACKERS_ONLY=0 NO_PUBLISH=0 DRY_RUN=0 ALLOW_UNSIGNED=0
declare -a COMBOS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --all)            USE_ALL=1 ;;
    --with-trackers)  WITH_TRACKERS=1 ;;
    --trackers-only)  TRACKERS_ONLY=1; WITH_TRACKERS=1 ;;
    --no-publish)     NO_PUBLISH=1 ;;
    --allow-unsigned) ALLOW_UNSIGNED=1 ;;
    --dry-run)        DRY_RUN=1 ;;
    --keep)           KEEP="$2"; shift ;;
    -h|--help)        sed -n '2,60p' "$0"; exit 0 ;;
    -*)               echo "unknown flag: $1" >&2; exit 2 ;;
    *)                COMBOS+=("$1") ;;
  esac
  shift
done

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
die() { log "FATAL: $*"; exit 1; }

# ── Preconditions ─────────────────────────────────────────────────────────
command -v "$XCHAIN_NODE_BIN" >/dev/null || die "xchain-node CLI not found ($XCHAIN_NODE_BIN)"
if [ ! -f "$SIGNING_KEY" ]; then
  [ "$ALLOW_UNSIGNED" = 1 ] || die "signing key not found: $SIGNING_KEY (use --allow-unsigned to publish unsigned)"
  log "WARNING: no signing key — archives will be UNSIGNED (--allow-unsigned)"
fi
mkdir -p "$STAGE_DIR" "$TMP_DIR" 2>/dev/null || die "cannot create STAGE_DIR/TMP_DIR (need writable $STAGE_DIR and $TMP_DIR)"

# ── Resolve combos ────────────────────────────────────────────────────────
# Auto-detect served combos from running containers (names: xchain-node-<coin>-<network>-<service>).
detect_combos() {
  docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -E "^xchain-node-.*-(xchain-decoder|xchain-indexer|xchain-utxo-tracker)$" \
    | while read -r n; do
        rest="${n#xchain-node-}"
        for svc in "${ALL_SERVICES[@]}"; do
          case "$rest" in
            *-"$svc")
              cn="${rest%-"$svc"}"            # <coin>-<network>
              coin="${cn%%-*}"; net="${cn#*-}"
              [ "$net" = "regtest" ] && break # skip regtest
              echo "$svc:$coin:$net"; break ;;
          esac
        done
      done | sort -u
}

if [ "${#COMBOS[@]}" -eq 0 ]; then
  [ "$USE_ALL" = 1 ] || die "no combos given. Pass <service>:<coin>:<network> args or --all."
  mapfile -t COMBOS < <(detect_combos)
  [ "${#COMBOS[@]}" -gt 0 ] || die "--all detected no served combos from running containers."
fi

# Apply tracker policy.
declare -a SELECTED=()
for c in "${COMBOS[@]}"; do
  svc="${c%%:*}"
  if [ "$svc" = "$TRACKER_SVC" ]; then
    [ "$WITH_TRACKERS" = 1 ] || { log "skip (tracker, needs --with-trackers): $c"; continue; }
  else
    [ "$TRACKERS_ONLY" = 1 ] && { log "skip (non-tracker, --trackers-only): $c"; continue; }
  fi
  SELECTED+=("$c")
done
[ "${#SELECTED[@]}" -gt 0 ] || die "no combos selected after tracker policy."

log "publish plan (${#SELECTED[@]}): ${SELECTED[*]}"
[ "$WITH_TRACKERS" = 1 ] && log "NOTE: tracker creates STOP the tracker container (downtime) for the compress."
if [ "$DRY_RUN" = 1 ]; then log "dry-run: nothing executed."; exit 0; fi

# ── Single-instance lock (cron-safe) ──────────────────────────────────────
exec 9>"$LOCK_FILE"
flock -n 9 || die "another publish run holds $LOCK_FILE — exiting."

# ── Per-combo: create -> verify signed -> publish -> prune ────────────────
fail=0; declare -a SUMMARY=()
for c in "${SELECTED[@]}"; do
  svc="${c%%:*}"; rest="${c#*:}"; coin="${rest%%:*}"; net="${rest##*:}"
  out_dir="$STAGE_DIR/$coin/$net/$svc/bootstrap"
  log "=== $svc $coin $net ==="

  if ! XCHAIN_NODE_BOOTSTRAP_SIGNING_KEY="$SIGNING_KEY" \
       XCHAIN_NODE_DATA_DIR="$STAGE_DIR" \
       XCHAIN_NODE_TMP_DIR="$TMP_DIR" \
       "$XCHAIN_NODE_BIN" bootstrap create "$svc" "$coin" "$net"; then
    log "  create FAILED for $c"; SUMMARY+=("$c: CREATE-FAIL"); fail=1; continue
  fi

  archive="$(ls -t "$out_dir"/*.tar.gz 2>/dev/null | head -1 || true)"
  [ -n "$archive" ] || { log "  no archive produced in $out_dir"; SUMMARY+=("$c: NO-ARCHIVE"); fail=1; continue; }
  if [ ! -f "$archive.sig" ] && [ "$ALLOW_UNSIGNED" != 1 ]; then
    log "  archive is UNSIGNED ($archive) — not publishing"; SUMMARY+=("$c: UNSIGNED"); fail=1; continue
  fi

  if [ "$NO_PUBLISH" = 1 ]; then
    log "  created (not published): $(basename "$archive")"; SUMMARY+=("$c: CREATED-LOCAL");
  else
    dest="$SYNC_DIR/$svc/$coin/$net"
    ssh -o BatchMode=yes "$SYNC_HOST" "mkdir -p '$dest'" || { log "  remote mkdir failed"; SUMMARY+=("$c: PUBLISH-FAIL"); fail=1; continue; }
    files=("$archive")
    [ -f "$archive.sig" ]    && files+=("$archive.sig")
    [ -f "$archive.sha256" ] && files+=("$archive.sha256")
    if scp -o BatchMode=yes "${files[@]}" "$SYNC_HOST:$dest/"; then
      log "  published $(basename "$archive") (+sig) to $SYNC_HOST:$dest"
      SUMMARY+=("$c: PUBLISHED")
      # Prune remote: keep newest $KEEP archives + their sidecars.
      ssh -o BatchMode=yes "$SYNC_HOST" "cd '$dest' && ls -t *.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | while read -r f; do rm -f \"\$f\" \"\$f.sig\" \"\$f.sha256\"; done" || log "  (remote prune warning)"
    else
      log "  scp FAILED"; SUMMARY+=("$c: PUBLISH-FAIL"); fail=1; continue
    fi
  fi

  # Prune local stage: keep newest $KEEP archives + sidecars to bound disk use.
  ( cd "$out_dir" && ls -t ./*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | while read -r f; do rm -f "$f" "$f.sig" "$f.sha256"; done ) || true
done

log "── summary ──"
for s in "${SUMMARY[@]}"; do log "  $s"; done
[ "$fail" = 0 ] && log "all selected combos OK" || log "one or more combos FAILED"
exit "$fail"
