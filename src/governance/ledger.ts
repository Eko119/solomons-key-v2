// Atomic proposal state transitions.
// All transitions are guarded by an optimistic-concurrency SQL UPDATE.
// APPROVED → MERGING is intentionally EXCLUDED — it is bootloader-exclusive
// and occurs only via dbAtomicLockForMerging in bootloader.ts.

import { dbUpdateProposalStatus } from './db';
import type { ProposalState } from './schema';

// ── Error type ───────────────────────────────────────────────────────────────

export class ProposalTransitionError extends Error {
  readonly code = 'PROPOSAL_TRANSITION_INVALID' as const;
  constructor(from: ProposalState, to: ProposalState) {
    super(`Illegal proposal transition: ${from} → ${to}`);
    this.name = 'ProposalTransitionError';
  }
}

// ── Ledger-allowed transitions ───────────────────────────────────────────────
// Subset of the full model — does NOT include APPROVED → MERGING.
// That lock is only obtainable by the bootloader.

const LEDGER_ALLOWED_TRANSITIONS: ReadonlyMap<ProposalState, ReadonlySet<ProposalState>> =
  new Map<ProposalState, ReadonlySet<ProposalState>>([
    ['DRAFTED',          new Set<ProposalState>(['PENDING_APPROVAL'])],
    ['PENDING_APPROVAL', new Set<ProposalState>(['APPROVED', 'REJECTED'])],
    ['APPROVED',         new Set<ProposalState>()],   // bootloader-exclusive path
    ['MERGING',          new Set<ProposalState>(['MERGED', 'FAILED'])],
    ['REJECTED',         new Set<ProposalState>()],
    ['MERGED',           new Set<ProposalState>()],
    ['FAILED',           new Set<ProposalState>()],
  ]);

// ── Validation ───────────────────────────────────────────────────────────────

export function validateProposalTransition(from: ProposalState, to: ProposalState): void {
  const allowed = LEDGER_ALLOWED_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    throw new ProposalTransitionError(from, to);
  }
}

// ── Atomic transition ────────────────────────────────────────────────────────

export function applyProposalTransition(
  id:   string,
  from: ProposalState,
  to:   ProposalState,
  now:  number,
): void {
  validateProposalTransition(from, to);
  const changes = dbUpdateProposalStatus(id, from, to, now);
  if (changes !== 1) {
    throw new Error(
      `applyProposalTransition: proposal ${id} not in state '${from}' ` +
      `(changes=${changes}) — concurrent modification or wrong expected state`,
    );
  }
}
