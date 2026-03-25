import { Button, SkeletonList } from '../UI';
import { TokenCard } from './TokenCard';
import { NoTokensEmptyState, NoWalletEmptyState } from '../UI';
import { useTransactionHistory } from '../../hooks/useTransactionHistory';
import type { WalletState } from '../../types';

interface TokenListProps {
  wallet: WalletState;
}

export function TokenList({ wallet }: TokenListProps) {
  const { history, loading, error, isEmpty, refreshFromBackend, isRefreshing } = useTransactionHistory();

  if (!wallet.connected) {
    return <NoWalletEmptyState />;
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="text-2xl font-bold text-gray-900">Your Tokens</h2>
        </div>
        <SkeletonList count={3} variant="card" />
      </div>
    );
  }

  if (isEmpty) {
    return <NoTokensEmptyState />;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold text-gray-900">
          Your Tokens ({history.length})
        </h2>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshFromBackend}
          loading={isRefreshing}
        >
          Refresh
        </Button>
      </div>

      {error && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-sm text-yellow-800">
            {error} - Showing local data only
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {history.map((token) => (
          <TokenCard
            key={token.address}
            token={token}
            network={wallet.network}
          />
        ))}
      </div>
    </div>
  );
}
