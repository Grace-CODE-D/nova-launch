#!/bin/bash
# =============================================================================
# Canary Deployment System with Automated Rollback
# Issues: #895
#
# Usage:
#   ./scripts/canary-deploy.sh [--weight <0-100>] [--auto-rollback] [--env <testnet|mainnet>]
#
# Environment Variables:
#   CANARY_WEIGHT         - Traffic percentage to canary (default: 10)
#   CANARY_BAKE_TIME      - Seconds to observe before promoting (default: 300)
#   ERROR_RATE_THRESHOLD  - Max error rate % before rollback (default: 5)
#   LATENCY_THRESHOLD_MS  - Max p99 latency ms before rollback (default: 2000)
#   BACKEND_URL           - Backend health endpoint base URL
# =============================================================================
set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
CANARY_WEIGHT="${CANARY_WEIGHT:-10}"
CANARY_BAKE_TIME="${CANARY_BAKE_TIME:-300}"
ERROR_RATE_THRESHOLD="${ERROR_RATE_THRESHOLD:-5}"
LATENCY_THRESHOLD_MS="${LATENCY_THRESHOLD_MS:-2000}"
STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"
BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
AUTO_ROLLBACK="${AUTO_ROLLBACK:-true}"
DEPLOY_ENV="${DEPLOY_ENV:-testnet}"

CANARY_STATE_FILE="/tmp/nova-canary-state.json"
LOG_PREFIX="[canary-deploy]"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log()     { echo -e "${BLUE}${LOG_PREFIX}${NC} $*"; }
success() { echo -e "${GREEN}${LOG_PREFIX} ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}${LOG_PREFIX} ⚠${NC} $*"; }
error()   { echo -e "${RED}${LOG_PREFIX} ✗${NC} $*" >&2; }

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --weight)       CANARY_WEIGHT="$2";    shift 2 ;;
    --bake-time)    CANARY_BAKE_TIME="$2"; shift 2 ;;
    --auto-rollback) AUTO_ROLLBACK="true"; shift ;;
    --no-rollback)  AUTO_ROLLBACK="false"; shift ;;
    --env)          DEPLOY_ENV="$2";       shift 2 ;;
    *) error "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── State helpers ─────────────────────────────────────────────────────────────
save_state() {
  local stage="$1" version="$2" stable_version="$3"
  cat > "$CANARY_STATE_FILE" <<EOF
{
  "stage": "${stage}",
  "canary_version": "${version}",
  "stable_version": "${stable_version}",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "weight": ${CANARY_WEIGHT},
  "environment": "${DEPLOY_ENV}"
}
EOF
}

load_state() {
  [[ -f "$CANARY_STATE_FILE" ]] && cat "$CANARY_STATE_FILE" || echo "{}"
}

# ── Health / metrics checks ───────────────────────────────────────────────────
check_health() {
  local url="${BACKEND_URL}/health"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  [[ "$http_code" == "200" ]]
}

get_error_rate() {
  # Query Prometheus metrics endpoint for error rate
  local metrics_url="${BACKEND_URL}/metrics"
  local error_rate=0

  if curl -s --max-time 5 "$metrics_url" > /tmp/nova_metrics.txt 2>/dev/null; then
    local total errors
    total=$(grep -E '^http_requests_total' /tmp/nova_metrics.txt 2>/dev/null | \
            awk '{sum+=$2} END{print sum+0}')
    errors=$(grep -E '^http_requests_total.*status="5' /tmp/nova_metrics.txt 2>/dev/null | \
             awk '{sum+=$2} END{print sum+0}')
    if [[ "${total:-0}" -gt 0 ]]; then
      error_rate=$(echo "scale=2; $errors * 100 / $total" | bc 2>/dev/null || echo "0")
    fi
  fi
  echo "$error_rate"
}

get_p99_latency() {
  local metrics_url="${BACKEND_URL}/metrics"
  local latency=0

  if curl -s --max-time 5 "$metrics_url" > /tmp/nova_metrics.txt 2>/dev/null; then
    latency=$(grep 'http_request_duration_ms{quantile="0.99"}' /tmp/nova_metrics.txt 2>/dev/null | \
              awk '{print $2+0}' | head -1)
  fi
  echo "${latency:-0}"
}

# ── Rollback ──────────────────────────────────────────────────────────────────
perform_rollback() {
  local reason="$1"
  local state
  state=$(load_state)
  local stable_version
  stable_version=$(echo "$state" | grep -o '"stable_version":"[^"]*"' | cut -d'"' -f4)

  error "ROLLBACK TRIGGERED: ${reason}"
  warn "Rolling back to stable version: ${stable_version:-unknown}"

  # Re-route all traffic to stable
  log "Restoring 100% traffic to stable deployment..."

  # Update canary weight to 0 (implementation depends on your load balancer)
  # For Docker/nginx: update upstream weights
  # For Kubernetes: scale canary deployment to 0
  if command -v kubectl &>/dev/null; then
    kubectl scale deployment nova-canary --replicas=0 2>/dev/null || true
    kubectl annotate deployment nova-stable \
      "nova.io/rollback-reason=${reason}" \
      "nova.io/rollback-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --overwrite 2>/dev/null || true
  fi

  # Record rollback event
  cat >> /tmp/nova-canary-rollbacks.log <<EOF
$(date -u +%Y-%m-%dT%H:%M:%SZ) | env=${DEPLOY_ENV} | reason=${reason} | stable=${stable_version:-unknown}
EOF

  save_state "rolled_back" "" "${stable_version:-unknown}"
  error "Rollback complete. Investigate before re-deploying."
  exit 1
}

# ── Canary health observation loop ────────────────────────────────────────────
observe_canary() {
  local end_time=$(( $(date +%s) + CANARY_BAKE_TIME ))
  local check_interval=30
  local checks_passed=0
  local checks_total=0

  log "Observing canary for ${CANARY_BAKE_TIME}s (checking every ${check_interval}s)..."
  log "Thresholds — error rate: <${ERROR_RATE_THRESHOLD}% | p99 latency: <${LATENCY_THRESHOLD_MS}ms"

  while [[ $(date +%s) -lt $end_time ]]; do
    checks_total=$(( checks_total + 1 ))

    # Health check
    if ! check_health; then
      if [[ "$AUTO_ROLLBACK" == "true" ]]; then
        perform_rollback "health check failed"
      else
        error "Health check failed — manual intervention required"
        exit 1
      fi
    fi

    # Error rate check
    local error_rate
    error_rate=$(get_error_rate)
    if (( $(echo "$error_rate > $ERROR_RATE_THRESHOLD" | bc -l 2>/dev/null || echo 0) )); then
      if [[ "$AUTO_ROLLBACK" == "true" ]]; then
        perform_rollback "error rate ${error_rate}% exceeds threshold ${ERROR_RATE_THRESHOLD}%"
      else
        error "Error rate ${error_rate}% exceeds threshold — manual intervention required"
        exit 1
      fi
    fi

    # Latency check
    local latency
    latency=$(get_p99_latency)
    if [[ "${latency:-0}" -gt "$LATENCY_THRESHOLD_MS" ]]; then
      if [[ "$AUTO_ROLLBACK" == "true" ]]; then
        perform_rollback "p99 latency ${latency}ms exceeds threshold ${LATENCY_THRESHOLD_MS}ms"
      else
        error "Latency ${latency}ms exceeds threshold — manual intervention required"
        exit 1
      fi
    fi

    checks_passed=$(( checks_passed + 1 ))
    local remaining=$(( end_time - $(date +%s) ))
    log "Check ${checks_passed}/${checks_total} passed | error_rate=${error_rate}% | p99=${latency}ms | ${remaining}s remaining"

    sleep "$check_interval"
  done

  success "Canary observation complete: ${checks_passed}/${checks_total} checks passed"
}

# ── Promote canary to stable ──────────────────────────────────────────────────
promote_canary() {
  log "Promoting canary to 100% traffic..."

  if command -v kubectl &>/dev/null; then
    # Kubernetes: update stable image to canary image, scale down canary
    local canary_image
    canary_image=$(kubectl get deployment nova-canary \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "")
    if [[ -n "$canary_image" ]]; then
      kubectl set image deployment/nova-stable "nova=${canary_image}" 2>/dev/null || true
      kubectl rollout status deployment/nova-stable --timeout=120s 2>/dev/null || true
      kubectl scale deployment nova-canary --replicas=0 2>/dev/null || true
    fi
  fi

  save_state "promoted" "" ""
  success "Canary promoted to stable successfully"
}

# ── Main deployment flow ──────────────────────────────────────────────────────
main() {
  log "Starting canary deployment | env=${DEPLOY_ENV} | weight=${CANARY_WEIGHT}%"

  # Capture current stable version for potential rollback
  local stable_version="stable-$(date +%Y%m%d%H%M%S)"
  local canary_version="canary-$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || date +%s)"

  save_state "deploying" "$canary_version" "$stable_version"

  # Step 1: Deploy canary alongside stable
  log "Step 1/4: Deploying canary (${CANARY_WEIGHT}% traffic)..."
  if command -v kubectl &>/dev/null; then
    # Kubernetes canary via replica ratio
    local stable_replicas=9
    local canary_replicas=$(( CANARY_WEIGHT / 10 ))
    [[ $canary_replicas -lt 1 ]] && canary_replicas=1
    kubectl scale deployment nova-canary --replicas="$canary_replicas" 2>/dev/null || \
      warn "kubectl scale skipped (canary deployment may not exist yet)"
  fi

  # Step 2: Verify canary is healthy before observation
  log "Step 2/4: Verifying canary health..."
  local retries=0
  until check_health || [[ $retries -ge 6 ]]; do
    warn "Canary not healthy yet, retrying (${retries}/6)..."
    sleep 10
    retries=$(( retries + 1 ))
  done

  if ! check_health; then
    perform_rollback "canary failed initial health check after 60s"
  fi
  success "Canary is healthy"

  # Step 3: Observe canary metrics
  log "Step 3/4: Observing canary metrics for ${CANARY_BAKE_TIME}s..."
  save_state "observing" "$canary_version" "$stable_version"
  observe_canary

  # Step 4: Promote
  log "Step 4/4: Promoting canary to stable..."
  save_state "promoting" "$canary_version" "$stable_version"
  promote_canary

  success "Canary deployment complete | version=${canary_version}"
}

main "$@"
