import { createHash } from 'node:crypto';
import { ALLOWED_TRANSITIONS, TERMINAL_STATES } from './schema';
import type { TaskState } from './schema';
import { dbUpdateState, dbInsertTransition, dbCountTransitions } from './db';

// ── Error type ───────────────────────────────────────────────────────────────

export class StateTransitionError extends Error {
  readonly code = 'STATE_TRANSITION_INVALID' as const;
  constructor(from: TaskState, to: TaskState) {
    super(`Illegal state transition: ${from} → ${to}`);
    this.name = 'StateTransitionError';
  }
}

// ── Transition validation ────────────────────────────────────────────────────

export function validateTransition(from: TaskState, to: TaskState): void {
  const allowed = ALLOWED_TRANSITIONS.get(from);
  if (!allowed || !allowed.has(to)) {
    throw new StateTransitionError(from, to);
  }
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

// ── Deterministic transition ID ──────────────────────────────────────────────
// SHA256(task_id : prior_transition_count : from : to : timestamp)
// prior_transition_count makes the ID unique even across repeated
// FAILED → PENDING retries with the same millisecond timestamp.

function transitionId(
  taskId:    string,
  seq:       number,
  from:      TaskState,
  to:        TaskState,
  timestamp: number,
): string {
  return createHash('sha256')
    .update(`${taskId}:${seq}:${from}:${to}:${timestamp}`)
    .digest('hex');
}

// ── Atomic state transition ──────────────────────────────────────────────────
// Validates the transition, updates task_nodes, inserts an audit record.
// Throws StateTransitionError on invalid transition.
// Throws Error if the row is not found in the expected from-state.

export function applyTransition(
  taskId: string,
  from:   TaskState,
  to:     TaskState,
  now:    number,
): void {
  validateTransition(from, to);

  const seq = dbCountTransitions(taskId); // prior count → unique tiebreaker
  const id  = transitionId(taskId, seq, from, to, now);

  const changes = dbUpdateState(taskId, from, to, now);
  if (changes !== 1) {
    throw new Error(
      `applyTransition: task ${taskId} not in state '${from}' ` +
      `(changes=${changes}) — concurrent modification or wrong expected state`,
    );
  }

  dbInsertTransition({ id, task_id: taskId, from_state: from, to_state: to, timestamp: now });
}
