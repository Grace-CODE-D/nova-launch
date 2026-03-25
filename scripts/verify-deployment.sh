#!/bin/bash
set -e

# ---------------------------------------------------------------------------
# Reads network and contract values from the canonical env file (.env.testnet
# by default) so this script always references the same values as the runtime
# services and the frontend.
# ---------------------------------------------------------------------------
ENV_FILE="${ENV_FILE:-.env.testnet}"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

# Fall back to deployment-testnet.json for backwards compatibility
if [ -z "$FACTORY_CONTRACT_ID" ]; then
  if [ ! -f "deployment-testnet.json" ]; then
    echo "Error: Neither $ENV_FILE nor deployment-testnet.json found. Deploy the contract first."
    exit 1
  fi
  FACTORY_CONTRACT_ID=$(grep -o '"contractId": "[^"]*' deployment-testnet.json | cut -d'"' -f4)
fi

STELLAR_NETWORK="${STELLAR_NETWORK:-testnet}"

if [ -z "$FACTORY_CONTRACT_ID" ]; then
  echo "Error: FACTORY_CONTRACT_ID is not set. Deploy the contract first."
  exit 1
fi

echo "Verifying deployment"
echo "  Network:     $STELLAR_NETWORK"
echo "  Contract ID: $FACTORY_CONTRACT_ID"
echo "================================================"

# Get factory state
echo -e "\n1. Factory State:"
soroban contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --network "$STELLAR_NETWORK" \
  --source admin \
  -- get_state

# Get admin address
ADMIN_ADDRESS=$(soroban keys address admin)

echo -e "\n2. Testing Token Creation:"
echo "Creating test token..."

TOKEN_ADDRESS=$(soroban contract invoke \
  --id "$FACTORY_CONTRACT_ID" \
  --network "$STELLAR_NETWORK" \
  --source admin \
  -- create_token \
  --creator "$ADMIN_ADDRESS" \
  --name "Verification Test Token" \
  --symbol "VTT" \
  --decimals 7 \
  --initial_supply 1000000 \
  --fee_payment 70000000)

echo "Test token created: $TOKEN_ADDRESS"

echo -e "\n3. Verification Complete!"
echo "================================================"
echo "All checks passed successfully."
