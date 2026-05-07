// Lease management for EFSM.
// Leases are mandatory for execution; no in-memory tracking.

import { dbGetBudget, dbFindExpiredExecuting, dbReleaseLease } from './db';
import { applyTransition } from './state-machine';

// ── Constants ────────────────────────────────────────────────────────────────

export const LEASE_DURATION_MS = 300_000; // 5 minutes

// ── Expired lease reclaim ────────────────────────────────────────────────────
// Called at the start of every scheduling cycle.
// For each EXECUTING task whose lease has expired:
//   EXECUTING → FAILED → PENDING  (if budget remains)
//   EXECUTING → FAILED → CANCELLED (if budget exhausted)
// Returns the number of tasks reclaimed.

export function reclaimExpiredLeases(now: number): number {
  const expired = dbFindExpiredExecuting(now);
  if (expired.length === 0) return 0;

  for (const task of expired) {
    // Transition EXECUTING → FAILED (lease expired = task crashed / timed out)
    applyTransition(task.id, 'EXECUTING', 'FAILED', now);
    dbReleaseLease(task.id, now);

    // Decide retry vs cancel based on remaining budget.
    // Budget was already decremented when the lease was first claimed,
    // so remaining_budget > 0 means there is budget for another attempt.
    const budget = dbGetBudget(task.id);
    if (budget && budget.remaining_budget > 0) {
      applyTransition(task.id, 'FAILED', 'PENDING', now);
    } else {
      applyTransition(task.id, 'FAILED', 'CANCELLED', now);
    }
  }

  return expired.length;
}
