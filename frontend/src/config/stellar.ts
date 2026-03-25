import { ENV } from './env';

const NETWORK_CONFIGS = {
  testnet: {
    networkPassphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  },
  mainnet: {
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-mainnet.stellar.org',
  },
} as const;

export const STELLAR_CONFIG = {
  network: ENV.NETWORK,
  factoryContractId: ENV.FACTORY_CONTRACT_ID,
  ...NETWORK_CONFIGS[ENV.NETWORK],
} as const;

/**
 * Returns the network config for the active network.
 * The optional `_network` parameter is accepted for backwards compatibility
 * but ignored — the active network is always determined by VITE_NETWORK.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const getNetworkConfig = (_network?: 'testnet' | 'mainnet') => NETWORK_CONFIGS[ENV.NETWORK];
