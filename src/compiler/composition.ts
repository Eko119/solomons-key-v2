// Composition Constitution — safety gate between Zod validation and compilation.
// Prevents "legal but lethal" multi-op combinations by detecting entity conflicts
// and guaranteeing order-independence via normalization.
//
// RULE: each logical entity (transition, table, constraint, capability) may appear
// in AT MOST ONE operation per proposal. Same-entity ops are order-dependent by
// definition and therefore structurally unsafe in a single batch.

import type { ProposalOp } from './ops';

// ── Entity key extraction ─────────────────────────────────────────────────────
// Returns the unique identifier for the logical entity an op targets.
// Two ops with the same key conflict by definition.

function entityKey(op: ProposalOp): string {
  switch (op.type) {
    case 'ADD_TRANSITION':
    case 'REMOVE_TRANSITION':
    case 'MODIFY_TRANSITION':
      return `TRANSITION:${op.from}:${op.to}`;
    case 'ADD_TABLE':
    case 'MODIFY_TABLE':
      return `TABLE:${op.tableName}`;
    case 'ADD_CONSTRAINT':
    case 'REMOVE_CONSTRAINT':
      return `CONSTRAINT:${op.name}`;
    case 'ADD_CAPABILITY':
    case 'REVOKE_CAPABILITY':
      return `CAPABILITY:${op.name}`;
  }
}

// ── Canonical type ordering ───────────────────────────────────────────────────
// Schema creation → modification → structural → constraints → capabilities.
// Defines the deterministic evaluation order after normalization.

const OP_TYPE_ORDER: Readonly<Record<string, number>> = {
  ADD_TABLE:         1,
  MODIFY_TABLE:      2,
  ADD_TRANSITION:    3,
  MODIFY_TRANSITION: 4,
  REMOVE_TRANSITION: 5,
  ADD_CONSTRAINT:    6,
  REMOVE_CONSTRAINT: 7,
  ADD_CAPABILITY:    8,
  REVOKE_CAPABILITY: 9,
};

// ── Normalization ─────────────────────────────────────────────────────────────
// Produces a canonical sorted representation — same logical ops always compile
// to the same artifact regardless of input order.

export function normalizeOps(ops: ReadonlyArray<ProposalOp>): ProposalOp[] {
  return [...ops].sort((a, b) => {
    const orderA = OP_TYPE_ORDER[a.type] ?? 99;
    const orderB = OP_TYPE_ORDER[b.type] ?? 99;
    if (orderA !== orderB) return orderA - orderB;
    return entityKey(a).localeCompare(entityKey(b));
  });
}

// ── Composition result ────────────────────────────────────────────────────────

export interface CompositionResult {
  valid:         boolean;
  normalizedOps: ProposalOp[];
  violations:    string[];
}

// ── Validator ─────────────────────────────────────────────────────────────────

export function validateComposition(ops: ReadonlyArray<ProposalOp>): CompositionResult {
  const violations: string[] = [];

  // Each entity key must appear at most once across all ops.
  // If the same entity appears in two ops, they are at minimum order-dependent
  // and at worst contradictory — both cases are unsafe in a single batch.
  const seen = new Map<string, string>(); // entityKey → first op.type

  for (const op of ops) {
    const key  = entityKey(op);
    const prev = seen.get(key);

    if (prev !== undefined) {
      // Classify the violation for a precise error message.
      const isContradiction =
        (op.type === 'REMOVE_TRANSITION'  && prev === 'ADD_TRANSITION')  ||
        (op.type === 'ADD_TRANSITION'     && prev === 'REMOVE_TRANSITION') ||
        (op.type === 'REVOKE_CAPABILITY'  && prev === 'ADD_CAPABILITY')   ||
        (op.type === 'ADD_CAPABILITY'     && prev === 'REVOKE_CAPABILITY') ||
        (op.type === 'REMOVE_CONSTRAINT'  && prev === 'ADD_CONSTRAINT')   ||
        (op.type === 'ADD_CONSTRAINT'     && prev === 'REMOVE_CONSTRAINT');

      const label = isContradiction ? 'Contradiction' : 'Order-unsafe conflict';
      violations.push(
        `${label}: ${key} is targeted by both '${prev}' and '${op.type}' ` +
        `in the same batch — same-entity ops are mutually exclusive`,
      );
    } else {
      seen.set(key, op.type);
    }
  }

  return {
    valid:         violations.length === 0,
    normalizedOps: normalizeOps(ops),
    violations,
  };
}
