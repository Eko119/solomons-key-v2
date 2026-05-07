// Execution receipt system.
// Receipts are append-only and immutable after insertion.
// effect_id is the idempotency key: SHA256(task_id + ":" + attempt_count).

import { createHash } from 'node:crypto';
import { dbInsertReceipt, dbGetReceiptByEffectId, dbGetLatestReceiptForTask } from './db';
import type { ExecutionReceipt } from './schema';

// ── Deterministic ID helpers ─────────────────────────────────────────────────

// effect_id as specified: SHA256(task_id + ":" + attempt_count)
export function computeEffectId(taskId: string, attemptCount: number): string {
  return createHash('sha256')
    .update(`${taskId}:${attemptCount}`)
    .digest('hex');
}

// SHA256 of arbitrary content — used for stdout_hash / stderr_hash.
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Deterministic receipt ID: SHA256("receipt:" + task_id + ":" + attempt_count)
function receiptId(taskId: string, attemptCount: number): string {
  return createHash('sha256')
    .update(`receipt:${taskId}:${attemptCount}`)
    .digest('hex');
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface ReceiptInput {
  taskId:     string;
  attempt:    number;
  effectId:   string;
  stdout:     string;
  stderr:     string;
  exitCode:   number;
  createdAt:  number;
}

// Stores the receipt. Idempotent on duplicate effect_id (UNIQUE constraint).
// Returns the stored receipt, either newly inserted or the existing one.
export function storeReceipt(input: ReceiptInput): ExecutionReceipt {
  const receipt: ExecutionReceipt = {
    id:          receiptId(input.taskId, input.attempt),
    task_id:     input.taskId,
    attempt:     input.attempt,
    effect_id:   input.effectId,
    stdout_hash: computeContentHash(input.stdout),
    stderr_hash: computeContentHash(input.stderr),
    exit_code:   input.exitCode,
    created_at:  input.createdAt,
  };

  try {
    dbInsertReceipt(receipt);
    return receipt;
  } catch (err: unknown) {
    // UNIQUE constraint on effect_id → already stored (crash-recovery path).
    const existing = dbGetReceiptByEffectId(input.effectId);
    if (existing) return existing;
    throw err; // genuine error
  }
}

// ── Lookup ───────────────────────────────────────────────────────────────────

export function getReceiptByEffectId(effectId: string): ExecutionReceipt | null {
  return dbGetReceiptByEffectId(effectId);
}

export function getLatestReceiptForTask(taskId: string): ExecutionReceipt | null {
  return dbGetLatestReceiptForTask(taskId);
}

// ── Verify ───────────────────────────────────────────────────────────────────
// Re-reads the stored receipt and confirms fields are internally consistent.

export function verifyReceipt(
  effectId:   string,
  stdout:     string,
  stderr:     string,
  exitCode:   number,
): boolean {
  const stored = dbGetReceiptByEffectId(effectId);
  if (!stored) return false;
  return (
    stored.effect_id   === effectId                 &&
    stored.stdout_hash === computeContentHash(stdout) &&
    stored.stderr_hash === computeContentHash(stderr) &&
    stored.exit_code   === exitCode
  );
}
