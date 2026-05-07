// CRITICAL SYSTEM GATE — single-instance transactional pipeline.
// No concurrency. No retries. No implicit rollback.
//
// Pipeline:
//   1. Atomic SQL lock: APPROVED → MERGING (changes ≠ 1 → abort)
//   2. Stage files to *.staged.* paths only
//   3. Phase 12 verification gate (npx tsx scripts/verify-efsm.ts)
//   4. PASS → overwrite production + mark MERGED + delete staged
//      FAIL → delete staged + mark FAILED (no production write)

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { dbGetProposal, dbAtomicLockForMerging } from './db';
import { applyProposalTransition } from './ledger';
import { ProposalDiffSchema } from './schema';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const TSX_BIN      = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');

// ── Helpers ──────────────────────────────────────────────────────────────────

function stagedPath(productionPath: string): string {
  const ext  = extname(productionPath);
  const base = basename(productionPath, ext);
  const dir  = dirname(productionPath);
  return resolve(dir, `${base}.staged${ext}`);
}

function cleanupStaged(path: string): void {
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
}

// ── Public result type ────────────────────────────────────────────────────────

export type BootloaderStatus = 'merged' | 'failed' | 'lock_failed';

export interface BootloaderResult {
  status: BootloaderStatus;
  reason?: string;
}

// ── Bootloader pipeline ───────────────────────────────────────────────────────

export function runBootloader(proposalId: string, now: number): BootloaderResult {

  // ── Step 1: Atomic lock acquisition ─────────────────────────────────────────
  // UPDATE schema_proposals SET status='MERGING' WHERE id=? AND status='APPROVED'
  // If changes ≠ 1: already consumed, invalid state, or race detected.
  const locked = dbAtomicLockForMerging(proposalId);
  if (locked !== 1) {
    return { status: 'lock_failed', reason: 'proposal not in APPROVED state or already consumed' };
  }

  const proposal = dbGetProposal(proposalId);
  if (!proposal) {
    // Defensive: proposal vanished between lock and read (should never happen).
    return { status: 'failed', reason: 'proposal not found after lock acquisition' };
  }

  // Parse structured diff payload.
  let diff: { targetFile: string; content: string };
  try {
    diff = ProposalDiffSchema.parse(JSON.parse(proposal.proposed_diff));
  } catch (e: unknown) {
    applyProposalTransition(proposalId, 'MERGING', 'FAILED', now);
    return {
      status: 'failed',
      reason: `malformed proposed_diff: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const productionPath = resolve(PROJECT_ROOT, diff.targetFile);
  const staged         = stagedPath(productionPath);

  // ── Step 2: Stage files — write ONLY to *.staged.* paths ────────────────────
  try {
    writeFileSync(staged, diff.content, 'utf8');
  } catch (e: unknown) {
    applyProposalTransition(proposalId, 'MERGING', 'FAILED', now);
    return {
      status: 'failed',
      reason: `staging write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // ── Step 3: Phase 12 verification gate ──────────────────────────────────────
  // Pass staged file path via env var so verify-efsm.ts checks staged content.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (proposal.target_layer === 'TLA_SPEC') {
    env['VERIFY_TLA_PATH'] = staged;
  } else if (proposal.target_layer === 'SQL_MIGRATION' || proposal.target_layer === 'CAPABILITY_REGISTRY') {
    env['VERIFY_SM_PATH'] = staged;
  }

  let verifyPassed = false;
  try {
    execFileSync(TSX_BIN, ['scripts/verify-efsm.ts'], { cwd: PROJECT_ROOT, env, stdio: 'pipe' });
    verifyPassed = true;
  } catch {
    verifyPassed = false;
  }

  // ── Step 4: Commit or rollback ───────────────────────────────────────────────
  if (!verifyPassed) {
    // FAIL path: delete staged, mark FAILED, NO production write.
    cleanupStaged(staged);
    applyProposalTransition(proposalId, 'MERGING', 'FAILED', now);
    return { status: 'failed', reason: 'Phase 12 verification failed' };
  }

  // PASS path: overwrite production from staged content, mark MERGED, delete staged.
  try {
    writeFileSync(productionPath, diff.content, 'utf8');
  } catch (e: unknown) {
    cleanupStaged(staged);
    applyProposalTransition(proposalId, 'MERGING', 'FAILED', now);
    return {
      status: 'failed',
      reason: `production write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  cleanupStaged(staged);
  applyProposalTransition(proposalId, 'MERGING', 'MERGED', now);
  return { status: 'merged' };
}
