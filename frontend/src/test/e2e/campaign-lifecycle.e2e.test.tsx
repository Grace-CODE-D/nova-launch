import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import CampaignDashboard, {
  type CampaignDashboardData,
  type CampaignTimelineEvent,
  type ContractCampaignState,
  projectBackendCampaignToSnapshot,
  projectContractCampaignToBackend,
} from '../../app/dashboard/CampaignDashboard';

function event(
  id: string,
  timestamp: number,
  category: 'execution' | 'lifecycle',
  action: string,
  details: string,
  step?: number,
): CampaignTimelineEvent {
  return { id, timestamp, category, action, details, step };
}

const t0 = 1_710_000_000_000;

const lifecycleStates: ContractCampaignState[] = [
  {
    id: 'cmp-lifecycle-1',
    name: 'Lifecycle E2E Campaign',
    status: 'active',
    budget: 1000,
    spent: 0,
    tokensBought: 0,
    tokensBurned: 0,
    executionCount: 0,
    auditTrail: [
      event('create', t0, 'lifecycle', 'Campaign created', 'Initial campaign creation'),
    ],
  },
  {
    id: 'cmp-lifecycle-1',
    name: 'Lifecycle E2E Campaign',
    status: 'paused',
    budget: 1000,
    spent: 0,
    tokensBought: 0,
    tokensBurned: 0,
    executionCount: 0,
    auditTrail: [
      event('create', t0, 'lifecycle', 'Campaign created', 'Initial campaign creation'),
      event('pause', t0 + 1_000, 'lifecycle', 'Campaign paused', 'Paused for risk guardrail review'),
    ],
  },
  {
    id: 'cmp-lifecycle-1',
    name: 'Lifecycle E2E Campaign',
    status: 'active',
    budget: 1000,
    spent: 0,
    tokensBought: 0,
    tokensBurned: 0,
    executionCount: 0,
    auditTrail: [
      event('create', t0, 'lifecycle', 'Campaign created', 'Initial campaign creation'),
      event('pause', t0 + 1_000, 'lifecycle', 'Campaign paused', 'Paused for risk guardrail review'),
      event('resume', t0 + 2_000, 'lifecycle', 'Campaign resumed', 'Resumed after approval'),
    ],
  },
  {
    id: 'cmp-lifecycle-1',
    name: 'Lifecycle E2E Campaign',
    status: 'active',
    budget: 1000,
    spent: 400,
    tokensBought: 380,
    tokensBurned: 350,
    executionCount: 1,
    auditTrail: [
      event('create', t0, 'lifecycle', 'Campaign created', 'Initial campaign creation'),
      event('pause', t0 + 1_000, 'lifecycle', 'Campaign paused', 'Paused for risk guardrail review'),
      event('resume', t0 + 2_000, 'lifecycle', 'Campaign resumed', 'Resumed after approval'),
      event('exec-1-buy', t0 + 3_000, 'execution', 'Buyback executed', 'Step 1 buy leg complete', 1),
      event('exec-1-burn', t0 + 3_200, 'execution', 'Tokens burned', 'Step 1 burn leg complete', 1),
    ],
  },
  {
    id: 'cmp-lifecycle-1',
    name: 'Lifecycle E2E Campaign',
    status: 'active',
    budget: 1000,
    spent: 700,
    tokensBought: 665,
    tokensBurned: 620,
    executionCount: 2,
    auditTrail: [
      event('create', t0, 'lifecycle', 'Campaign created', 'Initial campaign creation'),
      event('pause', t0 + 1_000, 'lifecycle', 'Campaign paused', 'Paused for risk guardrail review'),
      event('resume', t0 + 2_000, 'lifecycle', 'Campaign resumed', 'Resumed after approval'),
      event('exec-1-buy', t0 + 3_000, 'execution', 'Buyback executed', 'Step 1 buy leg complete', 1),
      event('exec-1-burn', t0 + 3_200, 'execution', 'Tokens burned', 'Step 1 burn leg complete', 1),
      event('exec-2-fail', t0 + 4_000, 'lifecycle', 'Execution failed', 'Price impact exceeded slippage cap'),
      event('exec-2-retry', t0 + 4_400, 'lifecycle', 'Retry succeeded', 'Recovered on second quote'),
      event('exec-2-buy', t0 + 4_600, 'execution', 'Buyback executed', 'Step 2 buy leg complete', 2),
      event('exec-2-burn', t0 + 4_800, 'execution', 'Tokens burned', 'Step 2 burn leg complete', 2),
    ],
  },
  {
    id: 'cmp-lifecycle-1',
    name: 'Lifecycle E2E Campaign',
    status: 'completed',
    budget: 1000,
    spent: 1000,
    tokensBought: 945,
    tokensBurned: 900,
    executionCount: 3,
    auditTrail: [
      event('create', t0, 'lifecycle', 'Campaign created', 'Initial campaign creation'),
      event('pause', t0 + 1_000, 'lifecycle', 'Campaign paused', 'Paused for risk guardrail review'),
      event('resume', t0 + 2_000, 'lifecycle', 'Campaign resumed', 'Resumed after approval'),
      event('exec-1-buy', t0 + 3_000, 'execution', 'Buyback executed', 'Step 1 buy leg complete', 1),
      event('exec-1-burn', t0 + 3_200, 'execution', 'Tokens burned', 'Step 1 burn leg complete', 1),
      event('exec-2-fail', t0 + 4_000, 'lifecycle', 'Execution failed', 'Price impact exceeded slippage cap'),
      event('exec-2-retry', t0 + 4_400, 'lifecycle', 'Retry succeeded', 'Recovered on second quote'),
      event('exec-2-buy', t0 + 4_600, 'execution', 'Buyback executed', 'Step 2 buy leg complete', 2),
      event('exec-2-burn', t0 + 4_800, 'execution', 'Tokens burned', 'Step 2 burn leg complete', 2),
      event('finalize', t0 + 5_000, 'lifecycle', 'Campaign finalized', 'Budget fully consumed and finalized'),
    ],
  },
];

function toDashboardPayload(state: ContractCampaignState, updatedAt: number): CampaignDashboardData {
  const backend = projectContractCampaignToBackend(state);
  const snapshot = projectBackendCampaignToSnapshot(backend);
  return { updatedAt, campaigns: [snapshot] };
}

function num(value: number): string {
  return value.toLocaleString('en-US');
}

describe('Campaign Lifecycle E2E', () => {
  it('covers create, pause, resume, execute, finalize and failure recovery with cross-layer alignment', async () => {
    for (let i = 0; i < lifecycleStates.length; i += 1) {
      const contract = lifecycleStates[i];
      const backend = projectContractCampaignToBackend(contract);
      const uiSnapshot = projectBackendCampaignToSnapshot(backend);

      // Cross-layer state alignment assertions.
      expect(backend.metrics.spent).toBe(contract.spent);
      expect(backend.metrics.bought).toBe(contract.tokensBought);
      expect(backend.metrics.burned).toBe(contract.tokensBurned);
      expect(backend.metrics.remainingBudget).toBe(contract.budget - contract.spent);
      expect(uiSnapshot.metrics.spent).toBe(backend.metrics.spent);
      expect(uiSnapshot.metrics.bought).toBe(backend.metrics.bought);
      expect(uiSnapshot.metrics.burned).toBe(backend.metrics.burned);
      expect(uiSnapshot.status).toBe(backend.status);

      const fetchCampaigns = async () => toDashboardPayload(contract, t0 + i * 10_000);
      const { unmount } = render(
        <CampaignDashboard fetchCampaigns={fetchCampaigns} pollIntervalMs={300000} staleAfterMs={600000} />,
      );

      expect(await screen.findByText('Lifecycle E2E Campaign')).toBeInTheDocument();
      expect(screen.getByTestId('metric-spent-cmp-lifecycle-1')).toHaveTextContent(num(contract.spent));
      expect(screen.getByTestId('metric-bought-cmp-lifecycle-1')).toHaveTextContent(num(contract.tokensBought));
      expect(screen.getByTestId('metric-burned-cmp-lifecycle-1')).toHaveTextContent(num(contract.tokensBurned));
      expect(screen.getByTestId('metric-remaining-cmp-lifecycle-1')).toHaveTextContent(
        num(contract.budget - contract.spent),
      );
      expect(screen.getByTestId('metric-status-cmp-lifecycle-1')).toHaveTextContent(contract.status);

      const latestLifecycle = contract.auditTrail
        .filter((item) => item.category === 'lifecycle')
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      expect(screen.getByText(latestLifecycle.action)).toBeInTheDocument();
      unmount();
    }
  });

  it('recovers from wallet disconnect and retry flow', async () => {
    let connected = false;
    let calls = 0;
    const fetchCampaigns = async () => {
      calls += 1;
      if (!connected) {
        throw new Error('Wallet disconnected');
      }
      return toDashboardPayload(lifecycleStates[3], t0 + 50_000);
    };

    const reconnect = async () => {
      connected = true;
    };

    render(
      <CampaignDashboard
        fetchCampaigns={fetchCampaigns}
        pollIntervalMs={300000}
        staleAfterMs={1}
        isWalletConnected={false}
        onReconnectWallet={reconnect}
      />,
    );

    expect(await screen.findByText('Wallet disconnected')).toBeInTheDocument();
    expect(await screen.findByTestId('dashboard-stale-indicator')).toHaveTextContent('Stale data');

    fireEvent.click(screen.getByTestId('wallet-reconnect-button'));

    await waitFor(() => {
      expect(screen.getByText('Lifecycle E2E Campaign')).toBeInTheDocument();
    });
    expect(screen.getByTestId('metric-status-cmp-lifecycle-1')).toHaveTextContent('active');
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
