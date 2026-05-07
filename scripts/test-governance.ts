#!/usr/bin/env npx ts-node
/**
 * Phase 13 governance mandatory test suite.
 *
 * Tests:
 *   1. No self-approval path     — bootloader cannot bypass PENDING_APPROVAL
 *   2. Bootloader exclusivity    — APPROVED → MERGING blocked via ledger
 *   3. Atomic failure safety     — broken proposal → FAILED, production unchanged
 *   4. Staging isolation         — no production write before verify passes
 *   5. Deterministic replay      — locked proposal cannot be double-executed
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

// Stub env vars before any module import.
const STUBS: Record<string, string> = {
  ANTHROPIC_API_KEY:          'test',
  TELEGRAM_BOT_TOKEN:         'test',
  TELEGRAM_ALLOWED_CHAT_IDS:  '1',
  GOOGLE_API_KEY:             'test',
  PIN_HASH:                   'a'.repeat(64),
  KILL_PHRASE:                'test',
  DASHBOARD_TOKEN:            'test',
  STORE_PATH:                 ':memory:',
  PROJECT_ROOT:               process.cwd(),
};
for (const [k, v] of Object.entries(STUBS)) {
  if (!process.env[k]) process.env[k] = v;
}

import { createProposal, submitForApproval } from '../src/governance/proposer';
import { applyProposalTransition, ProposalTransitionError } from '../src/governance/ledger';
import { dbGetProposal, dbAtomicLockForMerging } from '../src/governance/db';
import { runBootloader, recoverMergingProposals } from '../src/governance/bootloader';

const PROJECT_ROOT  = resolve(__dirname, '..');
const PROD_TLA_PATH = resolve(PROJECT_ROOT, 'formal_specs', 'efsm.tla');
const STAGED_PATH   = resolve(PROJECT_ROOT, 'formal_specs', 'efsm.staged.tla');

let seq = 0;
function uid(prefix = 'p'): string { return `${prefix}-${Date.now()}-${++seq}`; }
function readProductionTla(): string { return readFileSync(PROD_TLA_PATH, 'utf8'); }

// ── Test 1: No self-approval path ───────────────────────────────────────────
// The bootloader must fail at lock acquisition on a PENDING_APPROVAL proposal.
// There must be no internal code path that auto-advances to APPROVED.

async function testNoSelfApproval(): Promise<void> {
  const id  = uid();
  const now = Date.now();

  createProposal({
    id,
    target_layer: 'TLA_SPEC',
    diff: { targetFile: 'formal_specs/efsm.tla', content: readProductionTla() },
    justification: 'no self-approval test',
  }, now);

  submitForApproval(id, now + 1);

  // Bootloader on a PENDING_APPROVAL proposal must fail at lock (not APPROVED).
  const result = runBootloader(id, now + 2);
  assert.equal(result.status, 'lock_failed', 'bootloader must fail on PENDING_APPROVAL proposal');

  const p = dbGetProposal(id);
  assert.ok(p, 'proposal must exist');
  assert.equal(p!.status, 'PENDING_APPROVAL', 'proposal must remain in PENDING_APPROVAL');
}

// ── Test 2: Bootloader exclusivity ──────────────────────────────────────────
// The ledger must reject APPROVED → MERGING — that transition is gated behind
// the bootloader's atomic SQL lock only.

async function testBootloaderExclusivity(): Promise<void> {
  const id  = uid();
  const now = Date.now();

  createProposal({
    id,
    target_layer: 'TLA_SPEC',
    diff: { targetFile: 'formal_specs/efsm.tla', content: readProductionTla() },
    justification: 'bootloader exclusivity test',
  }, now);

  submitForApproval(id, now + 1);
  // Simulate external approval.
  applyProposalTransition(id, 'PENDING_APPROVAL', 'APPROVED', now + 2);

  // Direct ledger call for APPROVED → MERGING must throw.
  assert.throws(
    () => applyProposalTransition(id, 'APPROVED', 'MERGING', now + 3),
    ProposalTransitionError,
    'APPROVED → MERGING via ledger must throw ProposalTransitionError',
  );

  const p = dbGetProposal(id);
  assert.ok(p, 'proposal must exist');
  assert.equal(p!.status, 'APPROVED', 'proposal must remain APPROVED after rejected direct transition');
}

// ── Test 3: Atomic failure safety ───────────────────────────────────────────
// A proposal whose TLA+ content fails Phase 12 verification must:
//   — resolve to FAILED
//   — leave the production efsm.tla file unchanged
//   — leave no staged artefacts

async function testAtomicFailureSafety(): Promise<void> {
  const id             = uid();
  const now            = Date.now();
  const originalContent = readProductionTla();

  // Deliberately broken TLA+ — no TRANSITION comments → 0 transitions extracted.
  const brokenTla = '---- MODULE broken ----\nEXTENDS Naturals\nCONSTANTS Tasks\nVARIABLES state\n====\n';

  createProposal({
    id,
    target_layer: 'TLA_SPEC',
    diff: { targetFile: 'formal_specs/efsm.tla', content: brokenTla },
    justification: 'atomic failure safety test',
  }, now);
  submitForApproval(id, now + 1);
  applyProposalTransition(id, 'PENDING_APPROVAL', 'APPROVED', now + 2);

  const result = runBootloader(id, now + 3);
  assert.equal(result.status, 'failed', 'bootloader must fail with broken TLA+');

  // Production file must be unchanged.
  const afterContent = readProductionTla();
  assert.equal(afterContent, originalContent, 'production efsm.tla must not be mutated on verify failure');

  // Staged artefact must be cleaned up.
  assert.ok(!existsSync(STAGED_PATH), 'staged file must be deleted after bootloader failure');

  const p = dbGetProposal(id);
  assert.ok(p, 'proposal must exist');
  assert.equal(p!.status, 'FAILED', 'proposal must be FAILED');
}

// ── Test 4: Staging isolation ────────────────────────────────────────────────
// During bootloader execution, only *.staged.* paths are written before verify.
// After a failed verify, no production file is written and no staged file persists.

async function testStagingIsolation(): Promise<void> {
  const id             = uid();
  const now            = Date.now();
  const originalContent = readProductionTla();

  // Another broken proposal — verify will fail, so bootloader must not write production.
  const brokenTla = '---- MODULE isolation_test ----\nVARIABLES x\n====\n';

  createProposal({
    id,
    target_layer: 'TLA_SPEC',
    diff: { targetFile: 'formal_specs/efsm.tla', content: brokenTla },
    justification: 'staging isolation test',
  }, now);
  submitForApproval(id, now + 1);
  applyProposalTransition(id, 'PENDING_APPROVAL', 'APPROVED', now + 2);

  runBootloader(id, now + 3);

  // Production content unchanged — confirms no direct write to production path.
  assert.equal(readProductionTla(), originalContent, 'production file must not change when verify fails');

  // Staged artefact is gone — confirms cleanup in both pass and fail paths.
  assert.ok(!existsSync(STAGED_PATH), 'staged file must not persist after bootloader completes');
}

// ── Test 5: Deterministic replay ─────────────────────────────────────────────
// The same proposal ID cannot be executed twice.
// First run succeeds (MERGED). Second run returns lock_failed.

async function testDeterministicReplay(): Promise<void> {
  const id  = uid();
  const now = Date.now();

  createProposal({
    id,
    target_layer: 'TLA_SPEC',
    diff: { targetFile: 'formal_specs/efsm.tla', content: readProductionTla() },
    justification: 'deterministic replay test',
  }, now);
  submitForApproval(id, now + 1);
  applyProposalTransition(id, 'PENDING_APPROVAL', 'APPROVED', now + 2);

  // First run — valid TLA+ (identical to production) → should merge.
  const r1 = runBootloader(id, now + 3);
  assert.equal(r1.status, 'merged', `first bootloader run must merge, got ${r1.status}: ${r1.reason ?? ''}`);

  const p1 = dbGetProposal(id);
  assert.equal(p1!.status, 'MERGED', 'proposal must be MERGED after first run');

  // Second run on same ID — already MERGED, lock must fail.
  const r2 = runBootloader(id, now + 4);
  assert.equal(r2.status, 'lock_failed', 'second bootloader run on same ID must return lock_failed');
}

// ── Test 6: Crash recovery for MERGING proposals ─────────────────────────────
// Simulates a crash after APPROVED→MERGING lock but before staging completes.
// recoverMergingProposals must restage from DB, verify, and resolve deterministically.

async function testCrashRecoveryMerging(): Promise<void> {
  const id         = uid();
  const now        = Date.now();
  const targetFile = 'src/migrations/9999_recovery_test.sql';
  const targetPath = resolve(PROJECT_ROOT, targetFile);
  const stagedPath = resolve(PROJECT_ROOT, 'src', 'migrations', '9999_recovery_test.staged.sql');

  // Cleanup any artifacts from a previous failed run.
  if (existsSync(targetPath)) { try { unlinkSync(targetPath); } catch { /* */ } }
  if (existsSync(stagedPath)) { try { unlinkSync(stagedPath); } catch { /* */ } }

  try {
    // Build a proposal for a simple SQL migration (passes Phase 12 trivially).
    createProposal({
      id,
      target_layer: 'SQL_MIGRATION',
      diff: { targetFile, content: '-- crash recovery test\nSELECT 1;\n' },
      justification: 'crash recovery test',
    }, now);
    submitForApproval(id, now + 1);
    applyProposalTransition(id, 'PENDING_APPROVAL', 'APPROVED', now + 2);

    // Simulate bootloader acquiring the lock then crashing before writing staged file.
    const locked = dbAtomicLockForMerging(id);
    assert.equal(locked, 1, 'lock must be acquired');

    const p = dbGetProposal(id);
    assert.equal(p!.status, 'MERGING', 'proposal must be in MERGING (crashed state)');

    // No staged file exists — crash happened before staging.
    assert.ok(!existsSync(stagedPath), 'no orphan staged file should exist yet');

    // Recovery must resolve the proposal deterministically.
    const result = recoverMergingProposals(now + 3);
    assert.ok(result.recovered >= 1, `must recover at least 1 proposal, got ${result.recovered}`);

    const recovered = dbGetProposal(id);
    assert.ok(recovered, 'proposal must exist after recovery');
    assert.equal(recovered!.status, 'MERGED', `proposal must be MERGED after recovery, got ${recovered!.status}`);

    // Production file must exist and contain the correct content.
    assert.ok(existsSync(targetPath), 'production migration file must be written by recovery');
    const written = readFileSync(targetPath, 'utf8');
    assert.ok(written.includes('crash recovery test'), 'production file must contain the correct content');

    // Staged file must be cleaned up.
    assert.ok(!existsSync(stagedPath), 'staged file must not persist after recovery');
  } finally {
    if (existsSync(targetPath)) { try { unlinkSync(targetPath); } catch { /* */ } }
    if (existsSync(stagedPath)) { try { unlinkSync(stagedPath); } catch { /* */ } }
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ['no self-approval path',         testNoSelfApproval],
    ['bootloader exclusivity',        testBootloaderExclusivity],
    ['atomic failure safety',         testAtomicFailureSafety],
    ['staging isolation',             testStagingIsolation],
    ['deterministic replay',          testDeterministicReplay],
    ['crash recovery MERGING → MERGED', testCrashRecoveryMerging],
  ];

  let passed = 0;
  let failed = 0;

  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`[PASS] ${name}`);
      passed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[FAIL] ${name}: ${msg}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack.split('\n').slice(1, 4).join('\n'));
      }
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(`[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
