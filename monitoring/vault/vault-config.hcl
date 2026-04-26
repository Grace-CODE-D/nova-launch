# =============================================================================
# HashiCorp Vault Configuration — Nova Launch
# Issue: #896 — Secret Management with HashiCorp Vault
# =============================================================================

# ── Storage backend ───────────────────────────────────────────────────────────
storage "file" {
  path = "/vault/data"
}

# ── Listener ─────────────────────────────────────────────────────────────────
listener "tcp" {
  address       = "0.0.0.0:8200"
  tls_disable   = "true"   # Enable TLS in production with cert_file / key_file
  # tls_cert_file = "/vault/tls/vault.crt"
  # tls_key_file  = "/vault/tls/vault.key"
}

# ── API address ───────────────────────────────────────────────────────────────
api_addr     = "http://0.0.0.0:8200"
cluster_addr = "http://0.0.0.0:8201"

# ── UI ────────────────────────────────────────────────────────────────────────
ui = true

# ── Telemetry ─────────────────────────────────────────────────────────────────
telemetry {
  prometheus_retention_time = "30s"
  disable_hostname          = true
}

# ── Audit log ─────────────────────────────────────────────────────────────────
# Enable via: vault audit enable file file_path=/vault/logs/audit.log
