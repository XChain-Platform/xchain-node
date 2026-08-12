#!/usr/bin/env bash
# XChain DB backup -> off-site box. Dumps every XChain_* database on this host
# and rsyncs the gzipped dumps to the backup box, then prunes old copies.
#
# Credential safety: the MariaDB root password never leaves the DB container.
# Each docker-exec sources the container's own MYSQL_ROOT_PASSWORD, so the
# secret never reaches the host shell, argv, or any file this script writes.
#
# This is a DR backup, distinct from `xchain-node bootstrap create` (which
# exists to distribute signed auto-restore bootstraps to fresh installs).
# See the operator's backup/DR runbook for the full procedure, cron lines,
# and the restore drill.
set -euo pipefail

# --- config (override via env) ---
DB_CONTAINER="${XCHAIN_DB_CONTAINER:-xchain-node-database}"
STAGE_DIR="${XCHAIN_BACKUP_STAGE:-$HOME/xchain-backups}"
BACKUP_HOST="${XCHAIN_BACKUP_HOST:?set XCHAIN_BACKUP_HOST=user@backup-box}"
BACKUP_PATH="${XCHAIN_BACKUP_PATH:?set XCHAIN_BACKUP_PATH=/data/xchain-backups/$(hostname)}"
KEEP="${XCHAIN_BACKUP_KEEP:-7}"          # local + remote copies to retain per DB
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$STAGE_DIR"

# Two DB access modes, auto-detected: a containerized MariaDB (dev/regtest
# installs) or the native-DB prod install, where root auth is unix-socket
# (no password exists in host argv or env in either mode).
if docker inspect --type container --format '{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true; then
  DB_MODE="container"
  db_query() { docker exec "$DB_CONTAINER" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mariadb -u root -N -e "'"$1"'"'; }
  db_dump()  { docker exec "$DB_CONTAINER" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mariadb-dump -u root --single-transaction --routines --triggers '"$1"; }
elif sudo -n mariadb -N -e 'SELECT 1' >/dev/null 2>&1; then
  DB_MODE="native"
  db_query() { sudo -n mariadb -N -e "$1"; }
  db_dump()  { sudo -n mariadb-dump --single-transaction --routines --triggers "$1"; }
else
  echo "no $DB_CONTAINER container and no sudo socket-auth mariadb on $(hostname)" >&2
  exit 1
fi
echo "db mode: $DB_MODE"

# Discover XChain_* DBs.
mapfile -t DBS < <(db_query "SHOW DATABASES LIKE 'XChain\\_%'")

[ "${#DBS[@]}" -gt 0 ] || { echo "no XChain_* databases on $(hostname)"; exit 0; }

for DB in "${DBS[@]}"; do
  OUT="$STAGE_DIR/${DB}.${STAMP}.sql.gz"
  echo "dumping $DB -> $OUT"
  # --single-transaction = consistent snapshot without locking.
  db_dump "$DB" | gzip > "$OUT"
done

# Ship to the backup box.
rsync -a --mkpath "$STAGE_DIR"/ "$BACKUP_HOST:$BACKUP_PATH"/

# Retention: keep the newest $KEEP per DB, locally and remotely.
for DB in "${DBS[@]}"; do
  ls -1t "$STAGE_DIR/${DB}."*.sql.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
  ssh "$BACKUP_HOST" \
    "ls -1t '$BACKUP_PATH/${DB}.'*.sql.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f"
done

echo "backup complete: ${#DBS[@]} db(s) -> $BACKUP_HOST:$BACKUP_PATH"
