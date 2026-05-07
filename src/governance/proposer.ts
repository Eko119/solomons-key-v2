// Proposal creation only.
// Enforces DRAFTED-only insertion; no state transitions beyond PENDING_APPROVAL.

import { createHash } from 'node:crypto';
import { dbInsertProposal } from './db';
import { applyProposalTransition } from './ledger';
import { NewProposalInputSchema } from './schema';
import type { SchemaProposal, NewProposalInput } from './schema';

export function createProposal(input: NewProposalInput, now: number): SchemaProposal {
  const validated = NewProposalInputSchema.parse(input);
  const justification_hash = createHash('sha256')
    .update(validated.justification)
    .digest('hex');

  const proposal: SchemaProposal = {
    id:                 validated.id,
    target_layer:       validated.target_layer,
    proposed_diff:      JSON.stringify(validated.diff),
    justification_hash,
    status:             'DRAFTED',
    created_at:         now,
    resolved_at:        null,
  };

  dbInsertProposal(proposal);
  return proposal;
}

// Advances a DRAFTED proposal to PENDING_APPROVAL.
// This is the only state transition proposer.ts may perform.
export function submitForApproval(id: string, now: number): void {
  applyProposalTransition(id, 'DRAFTED', 'PENDING_APPROVAL', now);
}
