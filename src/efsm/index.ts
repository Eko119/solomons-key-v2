// Public API for the Executive Function State Machine (EFSM).
// All graph construction, execution, scheduling, and recovery goes through here.

import { createHash } from 'node:crypto';
import {
  dbInsertGraph, dbInsertNode, dbInsertDependency, dbActivateGraph,
  dbGetNode, dbGetGraph, dbGetNodesByGraph, dbInsertTransition, dbCountTransitions,
  dbGetTransitions,
} from './db';
import { validateDag } from './dag';
import { applyTransition } from './state-machine';
import { initBudget, getBudget, hasBudget } from './budget';
import { selectRunnableTasks } from './scheduler';
import { executeTask } from './engine';
import { recoverOnStartup } from './recovery';
import { getReceiptByEffectId, getLatestReceiptForTask, computeEffectId, computeContentHash } from './receipts';
import { NewNodeInputSchema } from './schema';
import type {
  TaskGraph, TaskNode, ExecutionReceipt, StateTransitionRecord,
  BudgetLedger, ExecutionOutcome, CapabilityExecutor, NewNodeInput,
} from './schema';

export type {
  TaskGraph, TaskNode, ExecutionReceipt, StateTransitionRecord,
  BudgetLedger, ExecutionOutcome, CapabilityExecutor, NewNodeInput,
};
export { StateTransitionError } from './state-machine';
export { DagValidationError } from './dag';
export { LEASE_DURATION_MS } from './lease';
export { computeEffectId, computeContentHash };
export type { TaskState, CapabilityResult } from './schema';

// ── Graph construction ───────────────────────────────────────────────────────

export function createGraph(id: string, rootGoal: string, now: number): TaskGraph {
  const g: TaskGraph = { id, root_goal: rootGoal, created_at: now };
  dbInsertGraph(g);
  return g;
}

export function addNode(input: NewNodeInput, now: number): TaskNode {
  const validated = NewNodeInputSchema.parse(input);
  const node: TaskNode = {
    id:                  validated.id,
    graph_id:            validated.graph_id,
    parent_id:           validated.parent_id,
    state:               'DRAFTED',
    capability_required: validated.capability_required,
    payload:             validated.payload,
    priority:            validated.priority,
    attempt_count:       0,
    max_attempts:        validated.max_attempts,
    lease_owner:         null,
    lease_expires_at:    null,
    effect_id:           null,
    created_at:          now,
    updated_at:          now,
  };
  dbInsertNode(node);
  initBudget(node.id, validated.initial_budget, now);
  return node;
}

export function addDependency(parentTaskId: string, childTaskId: string): void {
  dbInsertDependency({ parent_task_id: parentTaskId, child_task_id: childTaskId });
}

// Validates the DAG then transitions all DRAFTED nodes to PENDING atomically.
// Inserts state_transition audit records for each activated node.
// Throws DagValidationError if the graph is invalid.
export function finalizeGraph(graphId: string, now: number): number {
  validateDag(graphId);
  const activated = dbActivateGraph(graphId, now);

  // Insert transition records for the bulk DRAFTED → PENDING activation.
  // We cannot use applyTransition here because the state was already changed
  // in bulk by dbActivateGraph. We write audit records directly.
  const nodes = dbGetNodesByGraph(graphId);
  for (const n of nodes) {
    if (n.state === 'PENDING') {
      const seq = dbCountTransitions(n.id);
      const id  = createHash('sha256')
        .update(`${n.id}:${seq}:DRAFTED:PENDING:${now}`)
        .digest('hex');
      try {
        dbInsertTransition({
          id,
          task_id:    n.id,
          from_state: 'DRAFTED',
          to_state:   'PENDING',
          timestamp:  now,
        });
      } catch {
        // Duplicate on idempotent re-finalization — safe to ignore.
      }
    }
  }

  return activated;
}

// ── Scheduling ───────────────────────────────────────────────────────────────

export { selectRunnableTasks };

// ── Execution ────────────────────────────────────────────────────────────────

export { executeTask };

// ── Recovery ─────────────────────────────────────────────────────────────────

export { recoverOnStartup };

// ── Inspection ───────────────────────────────────────────────────────────────

export function getNode(id: string): TaskNode | null {
  return dbGetNode(id);
}

export function getGraph(id: string): TaskGraph | null {
  return dbGetGraph(id);
}

export function getTransitions(taskId: string): StateTransitionRecord[] {
  return dbGetTransitions(taskId);
}

export function getReceipt(effectId: string): ExecutionReceipt | null {
  return getReceiptByEffectId(effectId);
}

export function getLatestReceipt(taskId: string): ExecutionReceipt | null {
  return getLatestReceiptForTask(taskId);
}

export { getBudget, hasBudget };

// Cancel a task in DRAFTED or PENDING state.
export function cancelTask(taskId: string, now: number): void {
  const node = dbGetNode(taskId);
  if (!node) throw new Error(`cancelTask: task ${taskId} not found`);
  if (node.state === 'DRAFTED') {
    applyTransition(taskId, 'DRAFTED', 'PENDING', now);
    applyTransition(taskId, 'PENDING', 'CANCELLED', now);
  } else if (node.state === 'PENDING') {
    applyTransition(taskId, 'PENDING', 'CANCELLED', now);
  } else {
    throw new Error(`cancelTask: task ${taskId} is in state ${node.state} — cannot cancel`);
  }
}
