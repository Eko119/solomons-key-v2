// All SQL helpers for EFSM tables.
// Every function calls rawDb() directly — no in-memory caching.

import { rawDb } from '../db';
import type {
  TaskGraph, TaskNode, TaskDependency,
  ExecutionReceipt, StateTransitionRecord, BudgetLedger,
  ClaimOutcome,
} from './schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function d(): any { return rawDb(); }

// ── task_graphs ──────────────────────────────────────────────────────────────

export function dbInsertGraph(g: TaskGraph): void {
  d().prepare('INSERT INTO task_graphs (id, root_goal, created_at) VALUES (?, ?, ?)')
    .run(g.id, g.root_goal, g.created_at);
}

export function dbGetGraph(id: string): TaskGraph | null {
  return d().prepare('SELECT * FROM task_graphs WHERE id = ?').get(id) as TaskGraph | null;
}

// ── task_nodes ───────────────────────────────────────────────────────────────

export function dbInsertNode(n: TaskNode): void {
  d().prepare(`
    INSERT INTO task_nodes
      (id, graph_id, parent_id, state, capability_required, payload,
       priority, attempt_count, max_attempts, lease_owner, lease_expires_at,
       effect_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    n.id, n.graph_id, n.parent_id, n.state, n.capability_required, n.payload,
    n.priority, n.attempt_count, n.max_attempts,
    n.lease_owner, n.lease_expires_at, n.effect_id,
    n.created_at, n.updated_at,
  );
}

export function dbGetNode(id: string): TaskNode | null {
  return d().prepare('SELECT * FROM task_nodes WHERE id = ?').get(id) as TaskNode | null;
}

export function dbGetNodesByGraph(graphId: string): TaskNode[] {
  return d().prepare(
    'SELECT * FROM task_nodes WHERE graph_id = ? ORDER BY created_at ASC',
  ).all(graphId) as TaskNode[];
}

// Transition all DRAFTED nodes in a graph to PENDING atomically.
// Returns count of nodes transitioned.
export function dbActivateGraph(graphId: string, now: number): number {
  const r = d().prepare(`
    UPDATE task_nodes SET state = 'PENDING', updated_at = ?
    WHERE graph_id = ? AND state = 'DRAFTED'
  `).run(now, graphId);
  return r.changes as number;
}

// Update only the state + updated_at. Caller is responsible for validating the transition.
// Returns changes count (1 = success, 0 = row not found in expected state).
export function dbUpdateState(taskId: string, fromState: string, toState: string, now: number): number {
  const r = d().prepare(`
    UPDATE task_nodes SET state = ?, updated_at = ?
    WHERE id = ? AND state = ?
  `).run(toState, now, taskId, fromState);
  return r.changes as number;
}

// Clear lease fields without touching state.
export function dbReleaseLease(taskId: string, now: number): void {
  d().prepare(`
    UPDATE task_nodes
    SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ?
  `).run(now, taskId);
}

// Atomic combined operation: claim lease + decrement budget in one transaction.
// Returns 'claimed' | 'no_budget' | 'not_pending'.
export function dbClaimWithBudget(
  taskId:         string,
  leaseOwner:     string,
  leaseExpiresAt: number,
  newAttemptCount: number,
  effectId:       string,
  now:            number,
): ClaimOutcome {
  let outcome: ClaimOutcome = 'not_pending';

  const txn = d().transaction(() => {
    const node = d().prepare(
      'SELECT state FROM task_nodes WHERE id = ?',
    ).get(taskId) as { state: string } | null;

    if (!node || node.state !== 'PENDING') { outcome = 'not_pending'; return; }

    const budget = d().prepare(
      'SELECT remaining_budget FROM budget_ledger WHERE task_id = ?',
    ).get(taskId) as { remaining_budget: number } | null;

    if (!budget || budget.remaining_budget < 1) { outcome = 'no_budget'; return; }

    const claim = d().prepare(`
      UPDATE task_nodes
      SET state = 'EXECUTING',
          lease_owner = ?,
          lease_expires_at = ?,
          attempt_count = ?,
          effect_id = ?,
          updated_at = ?
      WHERE id = ? AND state = 'PENDING'
    `).run(leaseOwner, leaseExpiresAt, newAttemptCount, effectId, now, taskId);

    if ((claim.changes as number) !== 1) { outcome = 'not_pending'; return; }

    d().prepare(`
      UPDATE budget_ledger
      SET remaining_budget = remaining_budget - 1, updated_at = ?
      WHERE task_id = ?
    `).run(now, taskId);

    outcome = 'claimed';
  });

  txn();
  return outcome;
}

// ── task_dependencies ────────────────────────────────────────────────────────

export function dbInsertDependency(d_: TaskDependency): void {
  d().prepare(
    'INSERT INTO task_dependencies (parent_task_id, child_task_id) VALUES (?, ?)',
  ).run(d_.parent_task_id, d_.child_task_id);
}

export function dbGetDepsForGraph(graphId: string): TaskDependency[] {
  return d().prepare(`
    SELECT td.parent_task_id, td.child_task_id
    FROM task_dependencies td
    JOIN task_nodes tn ON tn.id = td.child_task_id
    WHERE tn.graph_id = ?
  `).all(graphId) as TaskDependency[];
}

export function dbGetParentsOf(taskId: string): string[] {
  return (d().prepare(
    'SELECT parent_task_id FROM task_dependencies WHERE child_task_id = ?',
  ).all(taskId) as Array<{ parent_task_id: string }>)
    .map(r => r.parent_task_id);
}

export function dbGetChildrenOf(taskId: string): string[] {
  return (d().prepare(
    'SELECT child_task_id FROM task_dependencies WHERE parent_task_id = ?',
  ).all(taskId) as Array<{ child_task_id: string }>)
    .map(r => r.child_task_id);
}

// ── Runnable task selection ──────────────────────────────────────────────────

// Returns PENDING tasks whose deps are all COMPLETED and which have no active lease.
// Expired leases (lease_expires_at < now) are treated as absent.
export function dbGetRunnablePending(now: number): TaskNode[] {
  return d().prepare(`
    SELECT n.*
    FROM task_nodes n
    WHERE n.state = 'PENDING'
      AND (n.lease_owner IS NULL OR n.lease_expires_at < ?)
      AND NOT EXISTS (
        SELECT 1
        FROM task_dependencies td
        JOIN task_nodes dep ON dep.id = td.parent_task_id
        WHERE td.child_task_id = n.id
          AND dep.state != 'COMPLETED'
      )
  `).all(now) as TaskNode[];
}

// Reclaim expired leases: moves EXECUTING tasks with expired leases back to PENDING.
// Inserts transition records externally (caller handles state-machine transitions).
// Returns the list of task IDs whose leases were reclaimed.
export function dbFindExpiredExecuting(now: number): TaskNode[] {
  return d().prepare(`
    SELECT * FROM task_nodes
    WHERE state = 'EXECUTING' AND lease_expires_at < ?
  `).all(now) as TaskNode[];
}

// ── execution_receipts ───────────────────────────────────────────────────────

export function dbInsertReceipt(r: ExecutionReceipt): void {
  d().prepare(`
    INSERT INTO execution_receipts
      (id, task_id, attempt, effect_id, stdout_hash, stderr_hash, exit_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.id, r.task_id, r.attempt, r.effect_id,
    r.stdout_hash, r.stderr_hash, r.exit_code, r.created_at);
}

export function dbGetReceiptByEffectId(effectId: string): ExecutionReceipt | null {
  return d().prepare(
    'SELECT * FROM execution_receipts WHERE effect_id = ?',
  ).get(effectId) as ExecutionReceipt | null;
}

export function dbGetLatestReceiptForTask(taskId: string): ExecutionReceipt | null {
  return d().prepare(
    'SELECT * FROM execution_receipts WHERE task_id = ? ORDER BY attempt DESC LIMIT 1',
  ).get(taskId) as ExecutionReceipt | null;
}

// ── state_transitions ────────────────────────────────────────────────────────

export function dbInsertTransition(t: StateTransitionRecord): void {
  d().prepare(`
    INSERT INTO state_transitions (id, task_id, from_state, to_state, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `).run(t.id, t.task_id, t.from_state, t.to_state, t.timestamp);
}

export function dbGetTransitions(taskId: string): StateTransitionRecord[] {
  return d().prepare(
    'SELECT * FROM state_transitions WHERE task_id = ? ORDER BY timestamp ASC',
  ).all(taskId) as StateTransitionRecord[];
}

export function dbCountTransitions(taskId: string): number {
  const r = d().prepare(
    'SELECT COUNT(*) AS n FROM state_transitions WHERE task_id = ?',
  ).get(taskId) as { n: number };
  return r.n;
}

// ── budget_ledger ────────────────────────────────────────────────────────────

export function dbInitBudget(taskId: string, budget: number, now: number): void {
  d().prepare(`
    INSERT INTO budget_ledger (task_id, remaining_budget, updated_at)
    VALUES (?, ?, ?)
  `).run(taskId, budget, now);
}

export function dbGetBudget(taskId: string): BudgetLedger | null {
  return d().prepare(
    'SELECT * FROM budget_ledger WHERE task_id = ?',
  ).get(taskId) as BudgetLedger | null;
}

// ── Recovery ─────────────────────────────────────────────────────────────────

export function dbGetIncompleteNodes(): TaskNode[] {
  return d().prepare(
    "SELECT * FROM task_nodes WHERE state IN ('EXECUTING', 'VERIFYING')",
  ).all() as TaskNode[];
}
