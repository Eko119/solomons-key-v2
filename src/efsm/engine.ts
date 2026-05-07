// 10-step deterministic execution pipeline.
// NO step may be skipped. Each step is explicitly labelled in comments.

import { dbGetNode, dbReleaseLease, dbClaimWithBudget, dbGetBudget } from './db';
import { validateDag, DagValidationError } from './dag';
import { applyTransition } from './state-machine';
import { computeEffectId, storeReceipt, getReceiptByEffectId, verifyReceipt } from './receipts';
import { LEASE_DURATION_MS } from './lease';
import type { ExecutionOutcome, CapabilityExecutor } from './schema';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Transition FAILED → PENDING if budget remains, else FAILED → CANCELLED.
function routeFailedTask(taskId: string, now: number): void {
  const budget = dbGetBudget(taskId);
  if (budget && budget.remaining_budget > 0) {
    applyTransition(taskId, 'FAILED', 'PENDING', now);
  } else {
    applyTransition(taskId, 'FAILED', 'CANCELLED', now);
  }
}

// ── Execution pipeline ───────────────────────────────────────────────────────

export async function executeTask(
  taskId:       string,
  leaseOwner:   string,
  capabilities: ReadonlyMap<string, CapabilityExecutor>,
  now:          number,
  leaseDurationMs: number = LEASE_DURATION_MS,
): Promise<ExecutionOutcome> {

  // ── Step 1: select runnable tasks (caller's responsibility; we receive taskId) ──

  // ── Step 2: validate DAG constraints ──────────────────────────────────────
  const node = dbGetNode(taskId);
  if (!node) return { status: 'not_found' };

  try {
    validateDag(node.graph_id);
  } catch (err: unknown) {
    if (err instanceof DagValidationError) {
      return { status: 'dag_invalid', reason: err.message };
    }
    throw err;
  }

  // ── Steps 3 + 4: acquire lease atomically + validate and decrement budget ──
  // Both happen in one SQLite transaction inside dbClaimWithBudget.
  const newAttemptCount = node.attempt_count + 1;
  const effectId        = computeEffectId(taskId, newAttemptCount);
  const leaseExpiresAt  = now + leaseDurationMs;

  // Idempotency guard: if a receipt for this effect_id already exists, a prior
  // execution completed but the state transition did not persist (crash recovery).
  // Skip directly to verification.
  const existingReceipt = getReceiptByEffectId(effectId);
  if (existingReceipt) {
    // Resume from VERIFYING (caller must have left task in EXECUTING or VERIFYING).
    if (node.state === 'EXECUTING') {
      applyTransition(taskId, 'EXECUTING', 'VERIFYING', now);
    }
    if (existingReceipt.exit_code === 0) {
      applyTransition(taskId, 'VERIFYING', 'COMPLETED', now);
      dbReleaseLease(taskId, now);
      return { status: 'completed' };
    }
    applyTransition(taskId, 'VERIFYING', 'FAILED', now);
    dbReleaseLease(taskId, now);
    routeFailedTask(taskId, now);
    return { status: 'failed', reason: `prior receipt exit_code=${existingReceipt.exit_code}` };
  }

  const claimResult = dbClaimWithBudget(
    taskId, leaseOwner, leaseExpiresAt, newAttemptCount, effectId, now,
  );

  if (claimResult === 'not_pending') {
    return { status: 'claim_failed', reason: 'task is not in PENDING state' };
  }

  if (claimResult === 'no_budget') {
    // Budget exhausted — cancel the task.
    const current = dbGetNode(taskId);
    if (current && current.state === 'PENDING') {
      applyTransition(taskId, 'PENDING', 'CANCELLED', now);
    }
    return { status: 'cancelled', reason: 'budget exhausted before execution' };
  }

  // Task is now EXECUTING with an active lease.

  // ── Step 5: execute capability-bound operation ─────────────────────────────
  const capFn = capabilities.get(node.capability_required);
  if (!capFn) {
    applyTransition(taskId, 'EXECUTING', 'FAILED', now);
    dbReleaseLease(taskId, now);
    routeFailedTask(taskId, now);
    return { status: 'failed', reason: `unknown capability: ${node.capability_required}` };
  }

  let capStdout = '';
  let capStderr = '';
  let capExit   = 0;
  try {
    const capResult = await capFn(node.payload, effectId);
    capStdout = capResult.stdout;
    capStderr = capResult.stderr;
    capExit   = capResult.exitCode;
  } catch (err: unknown) {
    capStderr = err instanceof Error ? err.message : String(err);
    capExit   = 1;
  }

  // ── Step 6: store execution receipt ───────────────────────────────────────
  storeReceipt({
    taskId,
    attempt:   newAttemptCount,
    effectId,
    stdout:    capStdout,
    stderr:    capStderr,
    exitCode:  capExit,
    createdAt: now,
  });

  // ── Step 7: transition state → VERIFYING ──────────────────────────────────
  applyTransition(taskId, 'EXECUTING', 'VERIFYING', now);

  // ── Step 8: verify receipt correctness ────────────────────────────────────
  const receiptOk = verifyReceipt(effectId, capStdout, capStderr, capExit);

  // ── Step 9: finalize state → COMPLETED or FAILED ──────────────────────────
  if (receiptOk && capExit === 0) {
    applyTransition(taskId, 'VERIFYING', 'COMPLETED', now);
    // ── Step 10: release lease ─────────────────────────────────────────────
    dbReleaseLease(taskId, now);
    return { status: 'completed' };
  }

  const failReason = !receiptOk
    ? 'receipt verification failed'
    : `capability exited with code ${capExit}: ${capStderr.slice(0, 200)}`;

  applyTransition(taskId, 'VERIFYING', 'FAILED', now);

  // ── Step 10: release lease ─────────────────────────────────────────────────
  dbReleaseLease(taskId, now);

  routeFailedTask(taskId, now);
  return { status: 'failed', reason: failReason };
}
