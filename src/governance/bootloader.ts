// CRITICAL SYSTEM GATE — single-instance transactional pipeline.
// No concurrency. No retries. No implicit rollback.
//
// Normal pipeline:
//   1. Atomic SQL lock: APPROVED → MERGING (changes ≠ 1 → abort)
//   2. Stage files to *.staged.* paths only
//   3. Phase 12 verification gate
//   4. PASS → overwrite production + mark MERGED + delete staged
//      FAIL → delete staged + mark FAILED (no production write)
//
// Crash recovery (recoverMergingProposals):
//   On startup, any proposal stuck in MERGING is replayed deterministically:
//   wipe orphan staged artifact → restage from DB payload (source of truth)
//   → re-run Phase 12 → commit or rollback atomically.

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { dbGetProposal, dbAtomicLockForMerging, dbGetProposalsByStatus } from './db';
import { applyProposalTransition } from './ledger';
import { ProposalDiffSchema } from './schema';

const PROJECT_ROOT = resolve(__dirname, '..', '..');
const TSX_BIN      = resolve(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');

// ── Shared helpers ────────────────────────────────────────────────────────────

function stagedPath(productionPath: string): string {
  const ext  = extname(productionPath);
  const base = basename(productionPath, ext);
  const dir  = dirname(productionPath);
  return resolve(dir, `${base}.staged${ext}`);
}

function cleanupStaged(stagedFilePath: string): void {
  if (existsSync(stagedFilePath)) {
    try { unlinkSync(stagedFilePath); } catch { /* already gone — idempotent */ }
  }
}

function buildVerifyEnv(targetFile: string, staged: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (targetFile.endsWith('efsm.tla')) {
    env['VERIFY_TLA_PATH'] = staged;
  } else if (targetFile.endsWith('state-machine.ts')) {
    env['VERIFY_SM_PATH'] = staged;
  }
  // All other target files (migration SQL, etc.): no override.
  // Verifier runs against current TLA+ and SQL projections, which are unchanged.
  return env;
}

function runVerifier(env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(TSX_BIN, ['scripts/verify-efsm.ts'], { cwd: PROJECT_ROOT, env, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Core commit/rollback logic shared by runBootloader and recoverMergingProposals.
// Precondition: proposal is already in MERGING state.
// Returns 'merged' | 'failed'.
function executeStageVerifyCommit(
  proposalId:     string,
  targetFile:     string,
  content:        string,
  now:            number,
): 'merged' | 'failed' {
  const productionPath = resolve(PROJECT_ROOT, targetFile);
  const staged         = stagedPath(productionPath);

  // Stage to *.staged.* path only.
  try {
    writeFileSync(staged, content, 'utf8');
  } catch {
    applyProposalTransition(proposalId, 'MERGING', 'FAILED', now);
    return 'failed';
  }

  const env = buildVerifyEnv(targetFile, staged);
  const verifyPassed = runVerifier(env);

  // Cleanup staged in both paths.
  cleanupStaged(staged);

  if (!verifyPassed) {
    applyProposalTransition(proposalId, 'MERGING', 'FAILED', now);
    return 'failed';
  }

  // Verification passed — overwrite production from staged content.
  try {
    writeFileSync(productionPath, content, 'utf8');
  } catch {
    applyProposalTransition(proposalId, 'MERGING', 'FAILED', now);
    return 'failed';
  }

  applyProposalTransition(proposalId, 'MERGING', 'MERGED', now);
  return 'merged';
}

// ── Public result types ───────────────────────────────────────────────────────

export type BootloaderStatus = 'merged' | 'failed' | 'lock_failed';

export interface BootloaderResult {
  status: BootloaderStatus;
  reason?: string;
}

export interface RecoveryResult {
  recovered: number;
  details:   string[];
}

// ── Normal bootloader pipeline ────────────────────────────────────────────────

export function runBootloader(proposalId: string, now: number): BootloaderResult {

  // ── Step 1: Atomic lock acquisition ─────────────────────────────────────────
  // UPDATE schema_proposals SET status='MERGING' WHERE id=? AND status='APPROVED'
  // If changes ≠ 1: already consumed, invalid state, or concurrent race.
  const locked = dbAtomicLockForMerging(proposalId);
  if (locked !== 1) {
    return { status: 'lock_failed', reason: 'proposal not in APPROVED state or already consumed' };
  }

  const proposal = dbGetProposal(proposalId);
  if (!proposal) {
    // Defensive: proposal vanished between lock and read (should never happen).
    return { status: 'failed', reason: 'proposal not found after lock acquisition' };
  }

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

  // ── Steps 2–4: Stage → Verify → Commit/Rollback ──────────────────────────────
  const outcome = executeStageVerifyCommit(proposalId, diff.targetFile, diff.content, now);
  if (outcome === 'failed') {
    return { status: 'failed', reason: 'Phase 12 verification failed or write error' };
  }
  return { status: 'merged' };
}

// ── Crash recovery ────────────────────────────────────────────────────────────
// Called on startup. Finds all proposals stuck in MERGING (orphaned by a crash),
// wipes any orphan staged artifacts, restages from the DB payload (source of truth),
// reruns Phase 12 verification, and resolves each proposal to MERGED or FAILED.
// Idempotent: safe to call multiple times.

export function recoverMergingProposals(now: number): RecoveryResult {
  const merging = dbGetProposalsByStatus('MERGING');
  const details: string[] = [];
  let recovered = 0;

  for (const proposal of merging) {
    let diff: { targetFile: string; content: string };
    try {
      diff = ProposalDiffSchema.parse(JSON.parse(proposal.proposed_diff));
    } catch (e: unknown) {
      applyProposalTransition(proposal.id, 'MERGING', 'FAILED', now);
      details.push(`${proposal.id}: FAILED (malformed payload — ${e instanceof Error ? e.message : String(e)})`);
      recovered++;
      continue;
    }

    // Wipe any orphan staged artifact left by the interrupted execution.
    const productionPath = resolve(PROJECT_ROOT, diff.targetFile);
    cleanupStaged(stagedPath(productionPath));

    // Restage from DB (source of truth) and re-run full verify → commit/rollback.
    const outcome = executeStageVerifyCommit(proposal.id, diff.targetFile, diff.content, now);
    details.push(
      outcome === 'merged'
        ? `${proposal.id}: MERGED (recovered from interrupted execution)`
        : `${proposal.id}: FAILED (Phase 12 verification or write error during recovery)`,
    );
    recovered++;
  }

  if (recovered > 0) {
    console.info(`[governance:recovery] resolved ${recovered} MERGING proposal(s)`);
    for (const detail of details) console.debug(`[governance:recovery]   ${detail}`);
  }

  return { recovered, details };
}
