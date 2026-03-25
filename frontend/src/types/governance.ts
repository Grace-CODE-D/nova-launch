/**
 * Governance Types for Frontend
 */

export enum ProposalType {
  PARAMETER_CHANGE = 'PARAMETER_CHANGE',
  ADMIN_TRANSFER = 'ADMIN_TRANSFER',
  TREASURY_SPEND = 'TREASURY_SPEND',
  CONTRACT_UPGRADE = 'CONTRACT_UPGRADE',
  CUSTOM = 'CUSTOM',
}

export enum ProposalStatus {
  ACTIVE = 'ACTIVE',
  PASSED = 'PASSED',
  REJECTED = 'REJECTED',
  EXECUTED = 'EXECUTED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
}

export interface ProposalParams {
  title: string;
  description: string;
  type: ProposalType;
  action: {
    contractId: string;
    functionName: string;
    args: any[];
  };
  proposer: string;
}

export interface VoteParams {
  proposalId: number;
  voter: string;
  support: boolean;
  reason?: string;
}

export interface GovernanceTransactionResult {
  txHash: string;
  status: 'pending' | 'success' | 'failed';
  timestamp: number;
}
