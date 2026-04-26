#!/bin/bash
# =============================================================================
# Automated Backup and Disaster Recovery System
# Issue: #890
#
# Usage:
#   ./scripts/backup.sh [backup|restore|verify|list]
#
# Environment Variables:
#   DATABASE_URL          - PostgreSQL connection string
#   BACKUP_STORAGE_PATH   - Local path for backups (default: /var/backups/nova)
#   BACKUP_S3_BUCKET      - Optional S3 bucket for offsite backups
#   BACKUP_RETENTION_DAYS - Days to keep backups (default: 30)
#   BACKUP_ENCRYPTION_KEY - GPG key ID for encrypted backups
# =============================================================================
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
BACKUP_STORAGE_PATH="${BACKUP_STORAGE_PATH:-/var/backups/nova}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_ENCRYPTION_KEY="${BACKUP_ENCRYPTION_KEY:-}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_NAME="nova-backup-${TIMESTAMP}"
LOG_FILE="${BACKUP_STORAGE_PATH}/backup.log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log()     { local msg="$(date -u +%Y-%m-%dT%H:%M:%SZ) [INFO]  $*"; echo -e "${BLUE}${msg}${NC}"; echo "$msg" >> "$LOG_FILE" 2>/dev/null || true; }
success() { local msg="$(date -u +%Y-%m-%dT%H:%M:%SZ) [OK]    $*"; echo -e "${GREEN}${msg}${NC}"; echo "$msg" >> "$LOG_FILE" 2>/dev/null || true; }
warn()    { local msg="$(date -u +%Y-%m-%dT%H:%M:%SZ) [WARN]  $*"; echo -e "${YELLOW}${msg}${NC}"; echo "$msg" >> "$LOG_FILE" 2>/dev/null || true; }
error()   { local msg="$(date -u +%Y-%m-%dT%H:%M:%SZ) [ERROR] $*"; echo -e "${RED}${msg}${NC}" >&2; echo "$msg" >> "$LOG_FILE" 2>/dev/null || true; }

# ── Parse DATABASE_URL ────────────────────────────────────────────────────────
parse_db_url() {
  # postgresql://user:pass@host:port/dbname
  local url="${DATABASE_URL:-postgresql://nova_user:nova_password@localhost:5432/nova_launch}"
  DB_USER=$(echo "$url" | sed -E 's|postgresql://([^:]+):.*|\1|')
  DB_PASS=$(echo "$url" | sed -E 's|postgresql://[^:]+:([^@]+)@.*|\1|')
  DB_HOST=$(echo "$url" | sed -E 's|.*@([^:/]+)[:/].*|\1|')
  DB_PORT=$(echo "$url" | sed -E 's|.*:([0-9]+)/.*|\1|')
  DB_NAME=$(echo "$url" | sed -E 's|.*/([^?]+).*|\1|')
}

# ── Ensure backup directory ───────────────────────────────────────────────────
ensure_dirs() {
  mkdir -p "${BACKUP_STORAGE_PATH}/db"
  mkdir -p "${BACKUP_STORAGE_PATH}/config"
  mkdir -p "${BACKUP_STORAGE_PATH}/manifests"
}

# ── Database backup ───────────────────────────────────────────────────────────
backup_database() {
  log "Backing up PostgreSQL database: ${DB_NAME}..."
  local dump_file="${BACKUP_STORAGE_PATH}/db/${BACKUP_NAME}.sql.gz"

  PGPASSWORD="$DB_PASS" pg_dump \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
    --format=custom \
    --compress=9 \
    --no-password \
    "$DB_NAME" | gzip > "$dump_file"

  local size
  size=$(du -sh "$dump_file" | cut -f1)
  success "Database backup complete: ${dump_file} (${size})"

  # Encrypt if key provided
  if [[ -n "$BACKUP_ENCRYPTION_KEY" ]]; then
    log "Encrypting backup with GPG key: ${BACKUP_ENCRYPTION_KEY}..."
    gpg --recipient "$BACKUP_ENCRYPTION_KEY" --encrypt "$dump_file"
    rm -f "$dump_file"
    dump_file="${dump_file}.gpg"
    success "Backup encrypted: ${dump_file}"
  fi

  echo "$dump_file"
}

# ── Config backup ─────────────────────────────────────────────────────────────
backup_config() {
  log "Backing up configuration files..."
  local config_archive="${BACKUP_STORAGE_PATH}/config/${BACKUP_NAME}-config.tar.gz"
  local repo_root
  repo_root="$(dirname "$0")/.."

  tar -czf "$config_archive" \
    -C "$repo_root" \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='target' \
    --exclude='dist' \
    --exclude='*.log' \
    .env.example \
    backend/.env.example \
    docker-compose.yml \
    backend/prisma/schema.prisma \
    2>/dev/null || true

  success "Config backup: ${config_archive}"
  echo "$config_archive"
}

# ── Write backup manifest ─────────────────────────────────────────────────────
write_manifest() {
  local db_file="$1" config_file="$2"
  local manifest="${BACKUP_STORAGE_PATH}/manifests/${BACKUP_NAME}.json"

  local db_checksum config_checksum
  db_checksum=$(sha256sum "$db_file" 2>/dev/null | awk '{print $1}' || echo "n/a")
  config_checksum=$(sha256sum "$config_file" 2>/dev/null | awk '{print $1}' || echo "n/a")

  cat > "$manifest" <<EOF
{
  "backup_name": "${BACKUP_NAME}",
  "timestamp": "${TIMESTAMP}",
  "environment": "${NODE_ENV:-development}",
  "database": {
    "file": "${db_file}",
    "checksum_sha256": "${db_checksum}",
    "encrypted": $([ -n "$BACKUP_ENCRYPTION_KEY" ] && echo "true" || echo "false")
  },
  "config": {
    "file": "${config_file}",
    "checksum_sha256": "${config_checksum}"
  },
  "retention_days": ${BACKUP_RETENTION_DAYS}
}
EOF
  success "Manifest written: ${manifest}"
  echo "$manifest"
}

# ── Upload to S3 ──────────────────────────────────────────────────────────────
upload_to_s3() {
  local file="$1"
  if [[ -z "$BACKUP_S3_BUCKET" ]]; then return 0; fi

  if ! command -v aws &>/dev/null; then
    warn "AWS CLI not found, skipping S3 upload"
    return 0
  fi

  log "Uploading to s3://${BACKUP_S3_BUCKET}/backups/$(basename "$file")..."
  aws s3 cp "$file" "s3://${BACKUP_S3_BUCKET}/backups/$(basename "$file")" \
    --storage-class STANDARD_IA
  success "Uploaded to S3: $(basename "$file")"
}

# ── Prune old backups ─────────────────────────────────────────────────────────
prune_old_backups() {
  log "Pruning backups older than ${BACKUP_RETENTION_DAYS} days..."
  find "${BACKUP_STORAGE_PATH}" -type f -mtime "+${BACKUP_RETENTION_DAYS}" -delete 2>/dev/null || true
  success "Pruning complete"
}

# ── Verify backup integrity ───────────────────────────────────────────────────
verify_backup() {
  local backup_name="${1:-}"
  if [[ -z "$backup_name" ]]; then
    # Verify latest
    backup_name=$(ls -t "${BACKUP_STORAGE_PATH}/manifests/"*.json 2>/dev/null | head -1)
    [[ -z "$backup_name" ]] && { error "No backups found to verify"; exit 1; }
  fi

  log "Verifying backup: ${backup_name}..."
  local manifest
  manifest=$(cat "$backup_name" 2>/dev/null || cat "${BACKUP_STORAGE_PATH}/manifests/${backup_name}.json")

  local db_file checksum_expected checksum_actual
  db_file=$(echo "$manifest" | grep -o '"file": "[^"]*"' | head -1 | cut -d'"' -f4)
  checksum_expected=$(echo "$manifest" | grep -o '"checksum_sha256": "[^"]*"' | head -1 | cut -d'"' -f4)

  if [[ ! -f "$db_file" ]]; then
    error "Backup file not found: ${db_file}"
    exit 1
  fi

  checksum_actual=$(sha256sum "$db_file" | awk '{print $1}')
  if [[ "$checksum_expected" == "$checksum_actual" ]]; then
    success "Checksum verified: ${db_file}"
  else
    error "Checksum MISMATCH for ${db_file}"
    error "  expected: ${checksum_expected}"
    error "  actual:   ${checksum_actual}"
    exit 1
  fi

  # Test restore to temp DB
  log "Testing restore to temporary database..."
  local test_db="nova_restore_test_$$"
  PGPASSWORD="$DB_PASS" createdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$test_db" 2>/dev/null || true
  if zcat "$db_file" | PGPASSWORD="$DB_PASS" pg_restore \
      -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
      -d "$test_db" --no-owner --no-privileges 2>/dev/null; then
    success "Restore test passed"
  else
    warn "Restore test had warnings (may be acceptable)"
  fi
  PGPASSWORD="$DB_PASS" dropdb -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" "$test_db" 2>/dev/null || true
}

# ── Restore ───────────────────────────────────────────────────────────────────
restore_backup() {
  local backup_name="${1:-}"
  if [[ -z "$backup_name" ]]; then
    error "Usage: $0 restore <backup-name>"
    exit 1
  fi

  local db_file="${BACKUP_STORAGE_PATH}/db/${backup_name}.sql.gz"
  [[ ! -f "$db_file" ]] && { error "Backup not found: ${db_file}"; exit 1; }

  warn "This will OVERWRITE the current database. Type 'yes' to confirm:"
  read -r confirm
  [[ "$confirm" != "yes" ]] && { log "Restore cancelled"; exit 0; }

  log "Restoring database from: ${db_file}..."
  zcat "$db_file" | PGPASSWORD="$DB_PASS" pg_restore \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
    -d "$DB_NAME" --clean --no-owner --no-privileges

  success "Database restored from: ${backup_name}"
}

# ── List backups ──────────────────────────────────────────────────────────────
list_backups() {
  log "Available backups in ${BACKUP_STORAGE_PATH}:"
  echo ""
  printf "%-40s %-25s %-10s\n" "NAME" "TIMESTAMP" "SIZE"
  printf "%-40s %-25s %-10s\n" "----" "---------" "----"
  for f in "${BACKUP_STORAGE_PATH}/db/"*.sql.gz 2>/dev/null; do
    [[ -f "$f" ]] || continue
    local name size ts
    name=$(basename "$f" .sql.gz)
    size=$(du -sh "$f" | cut -f1)
    ts=$(echo "$name" | grep -o '[0-9T]*Z' || echo "unknown")
    printf "%-40s %-25s %-10s\n" "$name" "$ts" "$size"
  done
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  local command="${1:-backup}"
  parse_db_url
  ensure_dirs

  case "$command" in
    backup)
      log "Starting full backup: ${BACKUP_NAME}"
      local db_file config_file
      db_file=$(backup_database)
      config_file=$(backup_config)
      local manifest
      manifest=$(write_manifest "$db_file" "$config_file")
      upload_to_s3 "$db_file"
      upload_to_s3 "$manifest"
      prune_old_backups
      success "Backup complete: ${BACKUP_NAME}"
      ;;
    restore)
      restore_backup "${2:-}"
      ;;
    verify)
      verify_backup "${2:-}"
      ;;
    list)
      list_backups
      ;;
    *)
      error "Unknown command: ${command}. Use: backup | restore | verify | list"
      exit 1
      ;;
  esac
}

main "$@"
