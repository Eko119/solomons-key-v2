// Finite operation algebra — the ONLY valid input surface for system evolution.
// 9 operations. No additional types permitted.

import { z } from 'zod';
import { TASK_STATES } from '../efsm/schema';

// ── Shared sub-schemas ───────────────────────────────────────────────────────

// Explicit condition fields — no free-form objects.
export const TransitionConditionSchema = z.object({
  requiresBudget:              z.boolean().optional(),
  requiresLease:               z.boolean().optional(),
  requiresReceiptVerification: z.boolean().optional(),
}).strict();
export type TransitionCondition = z.infer<typeof TransitionConditionSchema>;

export const ColumnTypeSchema = z.enum(['TEXT', 'INTEGER', 'REAL', 'BLOB']);

export const ColumnDefSchema = z.object({
  name:     z.string().min(1),
  type:     ColumnTypeSchema,
  nullable: z.boolean().optional(),
  unique:   z.boolean().optional(),
  check:    z.string().optional(),
  default:  z.union([z.string(), z.number(), z.null()]).optional(),
}).strict();
export type ColumnDef = z.infer<typeof ColumnDefSchema>;

// ── The 9 operation schemas ──────────────────────────────────────────────────

const AddTransitionSchema = z.object({
  type:      z.literal('ADD_TRANSITION'),
  from:      z.enum(TASK_STATES),
  to:        z.enum(TASK_STATES),
  condition: TransitionConditionSchema.optional(),
}).strict();

const RemoveTransitionSchema = z.object({
  type: z.literal('REMOVE_TRANSITION'),
  from: z.enum(TASK_STATES),
  to:   z.enum(TASK_STATES),
}).strict();

const ModifyTransitionSchema = z.object({
  type:      z.literal('MODIFY_TRANSITION'),
  from:      z.enum(TASK_STATES),
  to:        z.enum(TASK_STATES),
  condition: TransitionConditionSchema,
}).strict();

const AddConstraintSchema = z.object({
  type:      z.literal('ADD_CONSTRAINT'),
  name:      z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
  predicate: z.string().min(1),
}).strict();

const RemoveConstraintSchema = z.object({
  type: z.literal('REMOVE_CONSTRAINT'),
  name: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_]*$/),
}).strict();

const AddTableSchema = z.object({
  type:      z.literal('ADD_TABLE'),
  tableName: z.string().min(1).regex(/^[a-z_][a-z0-9_]*$/),
  columns:   z.array(ColumnDefSchema).nonempty(),
}).strict();

const ModifyTableSchema = z.object({
  type:        z.literal('MODIFY_TABLE'),
  tableName:   z.string().min(1).regex(/^[a-z_][a-z0-9_]*$/),
  addColumns:  z.array(ColumnDefSchema).optional(),
  dropColumns: z.array(z.string().min(1)).optional(),
}).strict();

const AddCapabilitySchema = z.object({
  type:        z.literal('ADD_CAPABILITY'),
  name:        z.string().min(1).regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/),
  description: z.string().min(1),
}).strict();

const RevokeCapabilitySchema = z.object({
  type: z.literal('REVOKE_CAPABILITY'),
  name: z.string().min(1),
}).strict();

// ── Union ────────────────────────────────────────────────────────────────────

export const ProposalOpSchema = z.discriminatedUnion('type', [
  AddTransitionSchema,
  RemoveTransitionSchema,
  ModifyTransitionSchema,
  AddConstraintSchema,
  RemoveConstraintSchema,
  AddTableSchema,
  ModifyTableSchema,
  AddCapabilitySchema,
  RevokeCapabilitySchema,
]);
export type ProposalOp = z.infer<typeof ProposalOpSchema>;
