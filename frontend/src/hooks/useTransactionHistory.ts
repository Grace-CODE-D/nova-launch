import { useState, useEffect, useMemo, useCallback } from 'react';
import { useWallet } from './useWallet';
import type { TokenInfo } from '../types';
import { transactionHistoryStorage } from '../services/TransactionHistoryStorage';
import { fetchTokenHistory, convertBackendToken } from '../services/tokenHistoryApi';

export interface Transaction {
  id: string;
  tokenName: string;
  tokenSymbol: string;
  contractAddress: string;
  timestamp: number;
  walletAddress: string;
}

interface UseTransactionHistoryReturn {
  history: TokenInfo[];
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  refreshFromBackend: () => Promise<void>;
  isRefreshing: boolean;
}

/**
 * Hook for managing token deployment history with backend synchronization
 * 
 * Features:
 * - Loads optimistic local records immediately
 * - Syncs with backend on mount and wallet change
 * - Deduplicates records by token address
 * - Treats backend as source of truth after confirmation
 * - Preserves pending optimistic entries
 */
export const useTransactionHistory = (): UseTransactionHistoryReturn => {
  const { wallet } = useWallet();
  const address = wallet.address;
  
  const [localHistory, setLocalHistory] = useState<TokenInfo[]>([]);
  const [backendHistory, setBackendHistory] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load local history immediately for optimistic UI
  useEffect(() => {
    if (!address) {
      setLocalHistory([]);
      setLoading(false);
      return;
    }

    try {
      const tokens = transactionHistoryStorage.getTokens(address);
      setLocalHistory(tokens);
    } catch (err) {
      console.error('Failed to load local history:', err);
      setError('Failed to load local history');
    } finally {
      setLoading(false);
    }
  }, [address]);

  // Fetch from backend on mount and when address changes
  const refreshFromBackend = useCallback(async () => {
    if (!address) {
      setBackendHistory([]);
      return;
    }

    setIsRefreshing(true);
    setError(null);

    try {
      const response = await fetchTokenHistory({
        creator: address,
        limit: 100, // Fetch more to ensure we get all user's tokens
        sortBy: 'created',
        sortOrder: 'desc',
      });

      if (response.success) {
        const convertedTokens = response.data.map(convertBackendToken);
        setBackendHistory(convertedTokens);
        
        // Reconcile: Update local storage with backend data
        reconcileWithBackend(address, convertedTokens);
      }
    } catch (err) {
      console.error('Failed to fetch backend history:', err);
      setError('Failed to sync with backend');
      // Don't clear local history on error - keep showing optimistic data
    } finally {
      setIsRefreshing(false);
    }
  }, [address]);

  // Auto-refresh from backend on mount and address change
  useEffect(() => {
    refreshFromBackend();
  }, [refreshFromBackend]);

  // Merge and deduplicate local and backend history
  const mergedHistory = useMemo(() => {
    if (!address) return [];

    // Create a map to deduplicate by token address
    const tokenMap = new Map<string, TokenInfo>();

    // First, add backend tokens (source of truth)
    backendHistory.forEach(token => {
      tokenMap.set(token.address, token);
    });

    // Then, add local tokens that aren't in backend yet (optimistic/pending)
    localHistory.forEach(token => {
      if (!tokenMap.has(token.address)) {
        // Mark as pending if not confirmed by backend
        tokenMap.set(token.address, {
          ...token,
          // Could add a 'pending' flag here if needed
        });
      }
    });

    // Convert to array and sort by deployment time (newest first)
    return Array.from(tokenMap.values()).sort(
      (a, b) => b.deployedAt - a.deployedAt
    );
  }, [localHistory, backendHistory, address]);

  return {
    history: mergedHistory,
    loading,
    error,
    isEmpty: mergedHistory.length === 0,
    refreshFromBackend,
    isRefreshing,
  };
};

/**
 * Reconcile local storage with backend data
 * Updates local records with confirmed backend data
 */
function reconcileWithBackend(walletAddress: string, backendTokens: TokenInfo[]): void {
  try {
    const localTokens = transactionHistoryStorage.getTokens(walletAddress);
    
    // Update local tokens with backend data if they exist
    backendTokens.forEach(backendToken => {
      const localToken = localTokens.find(t => t.address === backendToken.address);
      
      if (localToken) {
        // Update existing local record with backend data (source of truth)
        transactionHistoryStorage.addToken(walletAddress, backendToken);
      } else {
        // Add new token from backend that wasn't in local storage
        transactionHistoryStorage.addToken(walletAddress, backendToken);
      }
    });
  } catch (err) {
    console.error('Failed to reconcile with backend:', err);
  }
}