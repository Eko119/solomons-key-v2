// Budget management for EFSM.
// All budget state lives exclusively in budget_ledger (SQLite).

import { dbInitBudget, dbGetBudget } from './db';
import type { BudgetLedger } from './schema';

// ── Init ─────────────────────────────────────────────────────────────────────

export function initBudget(taskId: string, initialBudget: number, now: number): void {
  dbInitBudget(taskId, initialBudget, now);
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function getBudget(taskId: string): BudgetLedger | null {
  return dbGetBudget(taskId);
}

// ── Check (non-destructive) ──────────────────────────────────────────────────

export function hasBudget(taskId: string): boolean {
  const b = dbGetBudget(taskId);
  return b !== null && b.remaining_budget > 0;
}
