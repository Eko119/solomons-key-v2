// Raw SQL helpers for schema_proposals table.
// Every function calls rawDb() directly — no in-memory caching or logic.

import { rawDb } from '../db';
import { SchemaProposalSchema } from './schema';
import type { SchemaProposal, ProposalState } from './schema';

type Db = ReturnType<typeof rawDb>;

function db(): Db { return rawDb(); }

export function dbInsertProposal(p: SchemaProposal): void {
  db().prepare(`
    INSERT INTO schema_proposals
      (id, target_layer, proposed_diff, justification_hash, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(p.id, p.target_layer, p.proposed_diff, p.justification_hash, p.status, p.created_at, p.resolved_at);
}

export function dbGetProposal(id: string): SchemaProposal | null {
  const row = db().prepare('SELECT * FROM schema_proposals WHERE id = ?').get(id);
  if (!row) return null;
  return SchemaProposalSchema.parse(row);
}

export function dbGetProposalsByStatus(status: ProposalState): SchemaProposal[] {
  const rows = db().prepare('SELECT * FROM schema_proposals WHERE status = ?').all(status);
  return (rows as unknown[]).map(r => SchemaProposalSchema.parse(r));
}

// Applies a generic status transition with an optimistic-concurrency guard.
// Sets resolved_at for terminal states (REJECTED, MERGED, FAILED).
// Returns the number of rows affected (0 or 1).
export function dbUpdateProposalStatus(
  id:   string,
  from: ProposalState,
  to:   ProposalState,
  now:  number,
): number {
  const result = db().prepare(`
    UPDATE schema_proposals
    SET    status      = ?,
           resolved_at = CASE WHEN ? IN ('REJECTED','MERGED','FAILED') THEN ? ELSE resolved_at END
    WHERE  id = ? AND status = ?
  `).run(to, to, now, id, from);
  return (result as { changes: number }).changes;
}

// Bootloader-exclusive atomic lock: APPROVED → MERGING in one SQL statement.
// Returns the number of rows changed (1 = locked, 0 = already consumed / not approved).
export function dbAtomicLockForMerging(id: string): number {
  const result = db().prepare(`
    UPDATE schema_proposals
    SET status = 'MERGING'
    WHERE id = ? AND status = 'APPROVED'
  `).run(id);
  return (result as { changes: number }).changes;
}
