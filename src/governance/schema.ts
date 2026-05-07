import { z } from 'zod';

// ── State constants ──────────────────────────────────────────────────────────

export const PROPOSAL_STATES = [
  'DRAFTED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'MERGING', 'MERGED', 'FAILED',
] as const;
export type ProposalState = typeof PROPOSAL_STATES[number];

export const TARGET_LAYERS = ['TLA_SPEC', 'SQL_MIGRATION', 'CAPABILITY_REGISTRY'] as const;
export type TargetLayer = typeof TARGET_LAYERS[number];

// Complete state-machine model including the bootloader-exclusive transition.
// APPROVED → MERGING is intentionally absent from ledger.ts's allowed set —
// it only occurs via the atomic SQL lock in bootloader.ts.
export const PROPOSAL_ALLOWED_TRANSITIONS: ReadonlyMap<ProposalState, ReadonlySet<ProposalState>> =
  new Map<ProposalState, ReadonlySet<ProposalState>>([
    ['DRAFTED',          new Set<ProposalState>(['PENDING_APPROVAL'])],
    ['PENDING_APPROVAL', new Set<ProposalState>(['APPROVED', 'REJECTED'])],
    ['APPROVED',         new Set<ProposalState>(['MERGING'])],
    ['MERGING',          new Set<ProposalState>(['MERGED', 'FAILED'])],
    ['REJECTED',         new Set<ProposalState>()],
    ['MERGED',           new Set<ProposalState>()],
    ['FAILED',           new Set<ProposalState>()],
  ]);

export const TERMINAL_PROPOSAL_STATES: ReadonlySet<ProposalState> = new Set<ProposalState>([
  'REJECTED', 'MERGED', 'FAILED',
]);

// ── Row schemas ──────────────────────────────────────────────────────────────

export const SchemaProposalSchema = z.object({
  id:                 z.string().min(1),
  target_layer:       z.enum(TARGET_LAYERS),
  proposed_diff:      z.string(),
  justification_hash: z.string().length(64),
  status:             z.enum(PROPOSAL_STATES),
  created_at:         z.number().int().positive(),
  resolved_at:        z.number().int().positive().nullable(),
});
export type SchemaProposal = z.infer<typeof SchemaProposalSchema>;

// structured payload stored as JSON inside proposed_diff
export const ProposalDiffSchema = z.object({
  targetFile: z.string().min(1),
  content:    z.string(),
});
export type ProposalDiff = z.infer<typeof ProposalDiffSchema>;

export const NewProposalInputSchema = z.object({
  id:            z.string().min(1),
  target_layer:  z.enum(TARGET_LAYERS),
  diff:          ProposalDiffSchema,
  justification: z.string().min(1),
});
export type NewProposalInput = z.infer<typeof NewProposalInputSchema>;
