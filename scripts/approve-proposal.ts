#!/usr/bin/env npx ts-node
/**
 * External approval interface for schema proposals.
 *
 * Usage:
 *   npx tsx scripts/approve-proposal.ts approve <proposal-id>
 *   npx tsx scripts/approve-proposal.ts reject  <proposal-id>
 *
 * Allowed transitions (this CLI only):
 *   PENDING_APPROVAL → APPROVED
 *   PENDING_APPROVAL → REJECTED
 *
 * This CLI MUST NOT trigger a merge and MUST NOT access the filesystem.
 */

// Stub required env vars before any module import touches config.ts.
const STUBS: Record<string, string> = {
  ANTHROPIC_API_KEY:         'stub',
  TELEGRAM_BOT_TOKEN:        'stub',
  TELEGRAM_ALLOWED_CHAT_IDS: '0',
  GOOGLE_API_KEY:            'stub',
  PIN_HASH:                  'a'.repeat(64),
  KILL_PHRASE:               'stub',
  DASHBOARD_TOKEN:           'stub',
  PROJECT_ROOT:              process.cwd(),
};
for (const [k, v] of Object.entries(STUBS)) {
  if (!process.env[k]) process.env[k] = v;
}

import { dbGetProposal } from '../src/governance/db';
import { applyProposalTransition, ProposalTransitionError } from '../src/governance/ledger';

function usage(): void {
  console.error('Usage: approve-proposal <approve|reject> <proposal-id>');
  process.exit(1);
}

function main(): void {
  const [,, command, id] = process.argv;

  if (!command || !id) usage();
  if (command !== 'approve' && command !== 'reject') usage();

  const proposal = dbGetProposal(id!);
  if (!proposal) {
    console.error(`[approve-proposal] Proposal not found: ${id}`);
    process.exit(1);
  }

  if (proposal.status !== 'PENDING_APPROVAL') {
    console.error(
      `[approve-proposal] Cannot ${command}: proposal ${id} is in state ${proposal.status}, ` +
      'expected PENDING_APPROVAL',
    );
    process.exit(1);
  }

  const now = Date.now();
  const to  = command === 'approve' ? 'APPROVED' : 'REJECTED';

  try {
    applyProposalTransition(id!, 'PENDING_APPROVAL', to, now);
    console.log(`[approve-proposal] Proposal ${id} → ${to}`);
  } catch (e: unknown) {
    if (e instanceof ProposalTransitionError) {
      console.error(`[approve-proposal] Transition rejected: ${e.message}`);
    } else {
      console.error(`[approve-proposal] Unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(1);
  }
}

main();
