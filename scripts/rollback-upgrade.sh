#!/bin/bash

# Contract Rollback Script
# Rolls back to previous contract version.
#
# See docs/PRODUCTION_INTEGRATION_RUNBOOK.md — "Rollback" section for the
# full post-rollback verification sequence.

set -e

BACKUP_DIR="$1"
NETWORK="${2:-testnet}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Contract Rollback Tool               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
echo ""

# Validate backup directory
if [ -z "$BACKUP_DIR" ]; then
    echo -e "${RED}✗ Backup directory required${NC}"
    echo "  Usage: $0 <backup_dir> [network]"
    exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
    echo -e "${RED}✗ Backup directory not found: $BACKUP_DIR${NC}"
    exit 1
fi

echo -e "${YELLOW}[1/3] Loading Backup${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ! -f "$BACKUP_DIR/deployment-${NETWORK}.json" ]; then
    echo -e "${RED}✗ Backup deployment info not found${NC}"
    exit 1
fi

PREVIOUS_CONTRACT=$(jq -r '.contract_id' "$BACKUP_DIR/deployment-${NETWORK}.json")
echo -e "${GREEN}✓ Previous contract: $PREVIOUS_CONTRACT${NC}"

echo ""
echo -e "${YELLOW}[2/3] Restoring Configuration${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

cp "$BACKUP_DIR/deployment-${NETWORK}.json" "deployment-${NETWORK}.json"
echo -e "${GREEN}✓ Deployment info restored${NC}"

echo ""
echo -e "${YELLOW}[3/3] Verification${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if soroban contract invoke \
    --id "$PREVIOUS_CONTRACT" \
    --network "$NETWORK" \
    -- get_state &> /dev/null; then
    echo -e "${GREEN}✓ Previous contract is functional${NC}"
else
    echo -e "${RED}✗ Previous contract not accessible${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      Rollback Complete! ✓              ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "${GREEN}Restored Contract:${NC} $PREVIOUS_CONTRACT"
echo -e "${GREEN}Network:${NC} $NETWORK"
echo ""
