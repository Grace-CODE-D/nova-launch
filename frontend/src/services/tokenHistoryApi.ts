/**
 * Token History API Client
 * 
 * Provides methods to fetch token deployment history from the backend.
 * Serves as the source of truth for confirmed token deployments.
 */

import type { TokenInfo } from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

export interface TokenHistoryResponse {
  success: boolean;
  data: BackendTokenInfo[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface BackendTokenInfo {
  id: number;
  address: string;
  creator: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  initialSupply: string;
  totalBurned: string;
  burnCount: number;
  metadataUri?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FetchTokenHistoryOptions {
  creator?: string;
  page?: number;
  limit?: number;
  sortBy?: 'created' | 'name' | 'supply';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Fetch token deployment history for a specific creator from the backend
 */
export async function fetchTokenHistory(
  options: FetchTokenHistoryOptions = {}
): Promise<TokenHistoryResponse> {
  const {
    creator,
    page = 1,
    limit = 50,
    sortBy = 'created',
    sortOrder = 'desc',
  } = options;

  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString(),
    sortBy,
    sortOrder,
  });

  if (creator) {
    params.append('creator', creator);
  }

  const url = `${API_BASE_URL}/tokens/search?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data: TokenHistoryResponse = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to fetch token history:', error);
    throw error;
  }
}

/**
 * Convert backend token info to frontend TokenInfo format
 */
export function convertBackendToken(backendToken: BackendTokenInfo): TokenInfo {
  return {
    address: backendToken.address,
    name: backendToken.name,
    symbol: backendToken.symbol,
    decimals: backendToken.decimals,
    totalSupply: backendToken.totalSupply,
    creator: backendToken.creator,
    metadataUri: backendToken.metadataUri || undefined,
    deployedAt: new Date(backendToken.createdAt).getTime(),
    transactionHash: '', // Backend doesn't store this yet, will be empty
  };
}

/**
 * Fetch a single token by address
 */
export async function fetchTokenByAddress(address: string): Promise<BackendTokenInfo | null> {
  const url = `${API_BASE_URL}/tokens/search?q=${encodeURIComponent(address)}&limit=1`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const data: TokenHistoryResponse = await response.json();
    if (data.success && data.data.length > 0) {
      return data.data[0];
    }
    return null;
  } catch (error) {
    console.error('Failed to fetch token by address:', error);
    return null;
  }
}
