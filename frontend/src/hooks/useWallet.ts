import { useState, useEffect, useCallback, useRef } from 'react';
import { WalletService } from '../services/wallet';
import { analytics, AnalyticsEvent } from '../services/analytics';
import { ACTIVE_NETWORK, STELLAR_CONFIG } from '../config/stellar';
import { checkNetworkContractMismatch } from '../utils/validation';
import type { WalletState } from '../types';

export const WALLET_CONNECTED_KEY = 'nova_wallet_connected';
export const WALLET_STATE_KEY = 'nova_wallet_state';

interface PersistedWalletState {
    address: string;
    network: 'testnet' | 'mainnet';
}

function loadPersistedWalletState(): PersistedWalletState | null {
    try {
        const raw = localStorage.getItem(WALLET_STATE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PersistedWalletState;
        if (!parsed.address || !parsed.network) return null;
        return parsed;
    } catch {
        return null;
    }
}

function saveWalletState(address: string, network: 'testnet' | 'mainnet'): void {
    localStorage.setItem(WALLET_CONNECTED_KEY, 'true');
    localStorage.setItem(WALLET_STATE_KEY, JSON.stringify({ address, network }));
}

function clearWalletState(): void {
    localStorage.removeItem(WALLET_CONNECTED_KEY);
    localStorage.removeItem(WALLET_STATE_KEY);
}

interface UseWalletOptions {
    network?: 'testnet' | 'mainnet';
}

export const useWallet = (options: UseWalletOptions = {}) => {
    const { network: externalNetwork = 'testnet' } = options;
    const [wallet, setWallet] = useState<WalletState>({
        connected: false,
        address: null,
        network: externalNetwork,
    });
    const [isConnecting, setIsConnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [networkMismatchWarning, setNetworkMismatchWarning] = useState<string | null>(null);
    const cleanupRef = useRef<(() => void) | null>(null);
    const isInitializedRef = useRef(false);
    const prevNetworkRef = useRef(externalNetwork);

    const disconnect = useCallback(() => {
        setWallet((prev) => ({
            connected: false,
            address: null,
            network: prev.network,
        }));
        setError(null);
        clearWalletState();

        if (cleanupRef.current) {
            cleanupRef.current();
            cleanupRef.current = null;
        }

        try {
            analytics.track(AnalyticsEvent.WALLET_DISCONNECTED);
        } catch {}
    }, []);

    useEffect(() => {
        if (prevNetworkRef.current !== externalNetwork) {
            prevNetworkRef.current = externalNetwork;
            if (wallet.connected) {
                disconnect();
            }
            setWallet((prev) => ({ ...prev, network: externalNetwork }));
        }
    }, [externalNetwork, wallet.connected, disconnect]);

    const updateWalletState = useCallback(async () => {
        try {
            const isInstalled = await WalletService.isInstalled();
            if (!isInstalled) return false;

            const address = await WalletService.getPublicKey();
            if (!address) {
                disconnect();
                return false;
            }

            const network = await WalletService.getNetwork();
            setWallet({
                connected: true,
                address,
                network,
            });
            saveWalletState(address, network);

            // Check for network/contract mismatch
            const { mismatch, message } = checkNetworkContractMismatch(
                STELLAR_CONFIG.factoryContractId,
                network,
                ACTIVE_NETWORK
            );
            setNetworkMismatchWarning(mismatch ? (message ?? null) : null);

            // Privacy: do NOT send addresses or any PII. Only send non-identifying metadata.
            try {
                analytics.track(AnalyticsEvent.WALLET_CONNECTED, { network });
            } catch {}

            return true;
        } catch (err) {
            console.error('Failed to update wallet state:', err);
            disconnect();
            return false;
        }
    }, [disconnect]);

    const setupListeners = useCallback(() => {
        if (cleanupRef.current) cleanupRef.current();

        cleanupRef.current = WalletService.watchChanges(({ address, network }) => {
            const net = network.toLowerCase().includes('public') ? 'mainnet' : 'testnet';
            if (address) {
                setWallet({
                    connected: true,
                    address,
                    network: net as 'testnet' | 'mainnet',
                });
                saveWalletState(address, net as 'testnet' | 'mainnet');

                try {
                    analytics.track(AnalyticsEvent.NETWORK_SWITCHED, { to_network: net });
                } catch {}
            } else {
                disconnect();
            }
        });
    }, [disconnect]);

    const connect = useCallback(async () => {
        setIsConnecting(true);
        setError(null);

        try {
            const isInstalled = await WalletService.isInstalled();
            if (!isInstalled) {
                throw new Error('Freighter wallet is not installed');
            }

            const success = await updateWalletState();
            if (!success) {
                throw new Error('User rejected connection or account not found');
            }

            try {
                analytics.track('wallet_connect_initiated', { method: 'freighter' });
            } catch {}

            setupListeners();
        } catch (err: any) {
            setError(err.message || 'Failed to connect wallet');
            // Don't call disconnect() - we never connected, and it would clear the error
        } finally {
            setIsConnecting(false);
        }
    }, [updateWalletState, setupListeners, disconnect]);

    useEffect(() => {
        if (isInitializedRef.current) return;
        isInitializedRef.current = true;

        const wasConnected = localStorage.getItem(WALLET_CONNECTED_KEY) === 'true';
        if (wasConnected) {
            // Optimistically restore persisted state so the UI is not blank during re-validation
            const persisted = loadPersistedWalletState();
            if (persisted) {
                setWallet({ connected: true, address: persisted.address, network: persisted.network });
            }

            (async () => {
                const isInstalled = await WalletService.isInstalled();
                if (!isInstalled) {
                    clearWalletState();
                    setWallet((prev) => ({ connected: false, address: null, network: prev.network }));
                    return;
                }

                const success = await updateWalletState();
                if (success) {
                    setupListeners();
                } else {
                    // Wallet revoked or address changed — clear persisted state
                    clearWalletState();
                }
            })();
        }

        return () => {
            if (cleanupRef.current) {
                cleanupRef.current();
                cleanupRef.current = null;
            }
        };
    }, [updateWalletState, setupListeners]);

    return {
        wallet,
        connect,
        disconnect,
        isConnecting,
        error,
        networkMismatchWarning,
    };
};
