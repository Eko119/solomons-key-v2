import { z } from 'zod';

// ── State constants ──────────────────────────────────────────────────────────

export const TASK_STATES = [
  'DRAFTED', 'PENDING', 'EXECUTING', 'VERIFYING',
  'COMPLETED', 'FAILED', 'CANCELLED',
] as const;
export type TaskState = typeof TASK_STATES[number];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'COMPLETED', 'CANCELLED',
]);

// Allowed transitions: from-state → set of valid to-states.
// Any transition not listed here is a hard reject.
export const ALLOWED_TRANSITIONS: ReadonlyMap<TaskState, ReadonlySet<TaskState>> =
  new Map<TaskState, ReadonlySet<TaskState>>([
    ['DRAFTED',   new Set<TaskState>(['PENDING'])],
    ['PENDING',   new Set<TaskState>(['EXECUTING', 'CANCELLED'])],
    ['EXECUTING', new Set<TaskState>(['VERIFYING', 'FAILED'])],
    ['VERIFYING', new Set<TaskState>(['COMPLETED', 'FAILED'])],
    ['FAILED',    new Set<TaskState>(['PENDING', 'CANCELLED'])],
    ['COMPLETED', new Set<TaskState>()],
    ['CANCELLED', new Set<TaskState>()],
  ]);

// ── Row schemas ──────────────────────────────────────────────────────────────

export const TaskGraphSchema = z.object({
  id:         z.string().min(1),
  root_goal:  z.string().min(1),
  created_at: z.number().int().positive(),
});
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export const TaskNodeSchema = z.object({
  id:                  z.string().min(1),
  graph_id:            z.string().min(1),
  parent_id:           z.string().nullable(),
  state:               z.enum(TASK_STATES),
  capability_required: z.string().min(1),
  payload:             z.string(),
  priority:            z.number().int(),
  attempt_count:       z.number().int().nonnegative(),
  max_attempts:        z.number().int().positive(),
  lease_owner:         z.string().nullable(),
  lease_expires_at:    z.number().int().nullable(),
  effect_id:           z.string().nullable(),
  created_at:          z.number().int().positive(),
  updated_at:          z.number().int().positive(),
});
export type TaskNode = z.infer<typeof TaskNodeSchema>;

export const TaskDependencySchema = z.object({
  parent_task_id: z.string().min(1),
  child_task_id:  z.string().min(1),
});
export type TaskDependency = z.infer<typeof TaskDependencySchema>;

export const ExecutionReceiptSchema = z.object({
  id:          z.string().min(1),
  task_id:     z.string().min(1),
  attempt:     z.number().int().nonnegative(),
  effect_id:   z.string().min(1),
  stdout_hash: z.string().min(1),
  stderr_hash: z.string().min(1),
  exit_code:   z.number().int(),
  created_at:  z.number().int().positive(),
});
export type ExecutionReceipt = z.infer<typeof ExecutionReceiptSchema>;

export const StateTransitionRecordSchema = z.object({
  id:         z.string().min(1),
  task_id:    z.string().min(1),
  from_state: z.enum(TASK_STATES),
  to_state:   z.enum(TASK_STATES),
  timestamp:  z.number().int().positive(),
});
export type StateTransitionRecord = z.infer<typeof StateTransitionRecordSchema>;

export const BudgetLedgerSchema = z.object({
  task_id:          z.string().min(1),
  remaining_budget: z.number().int().nonnegative(),
  updated_at:       z.number().int().positive(),
});
export type BudgetLedger = z.infer<typeof BudgetLedgerSchema>;

// ── Input schemas ────────────────────────────────────────────────────────────

export const NewNodeInputSchema = z.object({
  id:                  z.string().min(1),
  graph_id:            z.string().min(1),
  parent_id:           z.string().nullable(),
  capability_required: z.string().min(1),
  payload:             z.string(),
  priority:            z.number().int().default(5),
  max_attempts:        z.number().int().positive().default(3),
  initial_budget:      z.number().int().positive(),
});
export type NewNodeInput = z.infer<typeof NewNodeInputSchema>;

// ── Outcome types (returned by engine, not persisted directly) ───────────────

export type ClaimOutcome = 'claimed' | 'no_budget' | 'not_pending';

export type ExecutionOutcome =
  | { status: 'completed' }
  | { status: 'failed';        reason: string }
  | { status: 'cancelled';     reason: string }
  | { status: 'claim_failed';  reason: string }
  | { status: 'not_found' }
  | { status: 'dag_invalid';   reason: string };

export interface CapabilityResult {
  stdout:   string;
  stderr:   string;
  exitCode: number;
}

export type CapabilityExecutor = (
  payload:  string,
  effectId: string,
) => Promise<CapabilityResult>;
