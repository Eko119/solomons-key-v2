import { z } from 'zod';
import { ProposalOpSchema } from './ops';

// ── Input: typed AST (the ONLY valid mutation surface) ───────────────────────

export const ProposalDiffV1Schema = z.object({
  version: z.literal('v1'),
  ops:     z.array(ProposalOpSchema).nonempty(),
}).strict();
export type ProposalDiff = z.infer<typeof ProposalDiffV1Schema>;

// ── Output: compiled artifacts ───────────────────────────────────────────────
//
// sqlMigrations     — DDL SQL for new/modified tables (CREATE TABLE, ALTER TABLE)
// tlaSpecPatches    — TLA+ operator blocks to add/remove from the spec
// capabilityUpdates — SQL for capability_registry (INSERT / UPDATE)
// projectionUpdates — Projection strings for TRANSITION_SQL_PROJECTIONS
//
// projectionUpdates is separate from sqlMigrations to avoid runtime SQL detection.

export const CompiledArtifactSchema = z.object({
  sqlMigrations:     z.array(z.string()),
  tlaSpecPatches:    z.array(z.string()),
  capabilityUpdates: z.array(z.string()),
  projectionUpdates: z.array(z.string()),
});
export type CompiledArtifact = z.infer<typeof CompiledArtifactSchema>;

// ── Pipeline result ───────────────────────────────────────────────────────────

export type PipelineStatus =
  | 'committed'
  | 'verification_failed'
  | 'compile_error'
  | 'validation_error'
  | 'lock_failed';

export interface PipelineResult {
  status:     PipelineStatus;
  proposalIds?: string[];
  artifact?:  CompiledArtifact;
  reason?:    string;
}

export interface PipelineOptions {
  migrationTargetFile?: string;  // override migration file path (for testing)
}
