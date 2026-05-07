#!/usr/bin/env npx ts-node
/**
 * Phase 14 — Operation Algebra mandatory test suite.
 *
 * Tests:
 *   1.  Zod rejects unknown op type
 *   2.  Zod rejects extra fields (strict mode)
 *   3.  Zod rejects missing required fields
 *   4.  Zod rejects empty ops array
 *   5.  Zod rejects wrong version string
 *   6.  ADD_TRANSITION compiles deterministically (correct TLA+ + SQL)
 *   7.  ADD_TABLE compiles correctly (DDL SQL, no TLA+ patches)
 *   8.  ADD_CAPABILITY compiles correctly (capability SQL, no TLA+ or migrations)
 *   9.  REVOKE_CAPABILITY compiles correctly
 *   10. Multiple ops accumulate correctly
 *   11. Pipeline: ADD_TABLE → Phase 12 → Phase 13 → committed
 *   12. Pipeline: ADD_CAPABILITY → Phase 12 → Phase 13 → committed
 *   13. Pipeline: invalid input → validation_error (no file writes)
 *   14. Deterministic replay: same input → identical artifact
 */

import assert from 'node:assert/strict';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';

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

import { ProposalDiffV1Schema } from '../src/compiler/schema';
import { compileProposal } from '../src/compiler/phase14-compiler';
import { executeProposalPipeline } from '../src/compiler/pipeline';

const PROJECT_ROOT = resolve(__dirname, '..');

let seq = 0;
function uid(prefix = 'p'): string { return `${prefix}-${Date.now()}-${++seq}`; }

// ─── 1. Zod rejects unknown op type ──────────────────────────────────────────
async function testRejectUnknownOp(): Promise<void> {
  const input = { version: 'v1', ops: [{ type: 'UNKNOWN_OP', x: 1 }] };
  assert.throws(
    () => ProposalDiffV1Schema.parse(input),
    ZodError,
    'unknown op type must throw ZodError',
  );
}

// ─── 2. Zod rejects extra fields (strict) ────────────────────────────────────
async function testRejectExtraFields(): Promise<void> {
  const input = {
    version: 'v1',
    ops: [{ type: 'ADD_TRANSITION', from: 'PENDING', to: 'EXECUTING', extraField: true }],
  };
  assert.throws(
    () => ProposalDiffV1Schema.parse(input),
    ZodError,
    'extra field on op must throw ZodError',
  );
}

// ─── 3. Zod rejects missing required fields ───────────────────────────────────
async function testRejectMissingFields(): Promise<void> {
  // ADD_TRANSITION requires both from and to.
  const input = { version: 'v1', ops: [{ type: 'ADD_TRANSITION', from: 'PENDING' }] };
  assert.throws(
    () => ProposalDiffV1Schema.parse(input),
    ZodError,
    'missing "to" field must throw ZodError',
  );
}

// ─── 4. Zod rejects empty ops array ──────────────────────────────────────────
async function testRejectEmptyOps(): Promise<void> {
  const input = { version: 'v1', ops: [] };
  assert.throws(
    () => ProposalDiffV1Schema.parse(input),
    ZodError,
    'empty ops array must throw ZodError',
  );
}

// ─── 5. Zod rejects wrong version ────────────────────────────────────────────
async function testRejectWrongVersion(): Promise<void> {
  const input = {
    version: 'v2',
    ops: [{ type: 'ADD_TRANSITION', from: 'PENDING', to: 'EXECUTING' }],
  };
  assert.throws(
    () => ProposalDiffV1Schema.parse(input),
    ZodError,
    'wrong version string must throw ZodError',
  );
}

// ─── 6. ADD_TRANSITION compiles deterministically ─────────────────────────────
async function testCompileAddTransition(): Promise<void> {
  const input = {
    version: 'v1',
    ops: [{ type: 'ADD_TRANSITION', from: 'EXECUTING', to: 'CANCELLED' }],
  };
  const diff = ProposalDiffV1Schema.parse(input);

  const art1 = compileProposal(diff);
  const art2 = compileProposal(diff);

  // Deterministic
  assert.deepEqual(art1, art2, 'same input must produce identical artifact');

  // Correct TLA+ patch
  assert.equal(art1.tlaSpecPatches.length, 1, 'must generate one TLA+ patch');
  assert.ok(
    art1.tlaSpecPatches[0]!.includes(`\\* TRANSITION state[t] = "EXECUTING" => state'[t] = "CANCELLED"`),
    'TLA+ patch must contain TRANSITION comment',
  );
  assert.ok(art1.tlaSpecPatches[0]!.includes('ExecutingToCancelled(t) =='), 'operator name must match');

  // Correct SQL projection
  assert.equal(art1.projectionUpdates.length, 1, 'must generate one projection');
  assert.equal(
    art1.projectionUpdates[0],
    "UPDATE task_nodes SET state='CANCELLED' WHERE state='EXECUTING'",
    'SQL projection must match canonical pattern',
  );

  // No DDL or capability output
  assert.equal(art1.sqlMigrations.length, 0, 'no DDL SQL for transition op');
  assert.equal(art1.capabilityUpdates.length, 0, 'no capability SQL for transition op');
}

// ─── 7. ADD_TABLE compiles correctly ─────────────────────────────────────────
async function testCompileAddTable(): Promise<void> {
  const input = {
    version: 'v1',
    ops: [{
      type: 'ADD_TABLE',
      tableName: 'test_events',
      columns: [
        { name: 'id', type: 'TEXT', nullable: false },
        { name: 'payload', type: 'TEXT' },
        { name: 'created_at', type: 'INTEGER', nullable: false },
      ],
    }],
  };
  const diff = ProposalDiffV1Schema.parse(input);
  const art  = compileProposal(diff);

  assert.equal(art.sqlMigrations.length, 1, 'must generate one DDL statement');
  assert.ok(art.sqlMigrations[0]!.includes('CREATE TABLE IF NOT EXISTS test_events'), 'must include CREATE TABLE');
  assert.ok(art.sqlMigrations[0]!.includes('id TEXT'), 'must include id column');
  assert.equal(art.tlaSpecPatches.length, 0, 'no TLA+ patches for table op');
  assert.equal(art.projectionUpdates.length, 0, 'no projection updates for table op');
}

// ─── 8. ADD_CAPABILITY compiles correctly ─────────────────────────────────────
async function testCompileAddCapability(): Promise<void> {
  const input = {
    version: 'v1',
    ops: [{ type: 'ADD_CAPABILITY', name: 'web_search', description: 'Search the web' }],
  };
  const diff = ProposalDiffV1Schema.parse(input);
  const art  = compileProposal(diff);

  assert.equal(art.capabilityUpdates.length, 1, 'must generate one capability SQL');
  assert.ok(art.capabilityUpdates[0]!.includes("'web_search'"), 'must include capability name');
  assert.ok(art.capabilityUpdates[0]!.includes("INSERT OR IGNORE INTO capability_registry"), 'must be an INSERT');
  assert.equal(art.sqlMigrations.length, 0, 'no DDL migrations for capability op');
  assert.equal(art.tlaSpecPatches.length, 0, 'no TLA+ patches for capability op');
}

// ─── 9. REVOKE_CAPABILITY compiles correctly ──────────────────────────────────
async function testCompileRevokeCapability(): Promise<void> {
  const input = {
    version: 'v1',
    ops: [{ type: 'REVOKE_CAPABILITY', name: 'web_search' }],
  };
  const diff = ProposalDiffV1Schema.parse(input);
  const art  = compileProposal(diff);

  assert.equal(art.capabilityUpdates.length, 1, 'must generate one capability SQL');
  assert.ok(art.capabilityUpdates[0]!.includes('REVOKED'), 'must set status REVOKED');
  assert.ok(art.capabilityUpdates[0]!.includes("'web_search'"), 'must reference capability name');
}

// ─── 10. Multiple ops accumulate correctly ────────────────────────────────────
async function testMultipleOps(): Promise<void> {
  const input = {
    version: 'v1',
    ops: [
      { type: 'ADD_CAPABILITY', name: 'cap_a', description: 'A' },
      { type: 'ADD_CAPABILITY', name: 'cap_b', description: 'B' },
    ],
  };
  const diff = ProposalDiffV1Schema.parse(input);
  const art  = compileProposal(diff);

  assert.equal(art.capabilityUpdates.length, 2, 'two ops → two capability SQL entries');
  assert.ok(art.capabilityUpdates[0]!.includes("'cap_a'"), 'first entry is cap_a');
  assert.ok(art.capabilityUpdates[1]!.includes("'cap_b'"), 'second entry is cap_b');
}

// ─── 11. Pipeline: ADD_TABLE → committed ─────────────────────────────────────
async function testPipelineAddTable(): Promise<void> {
  const targetFile = 'src/migrations/9999_phase14_table_test.sql';
  const targetPath = resolve(PROJECT_ROOT, targetFile);

  // Clean up from previous run if exists.
  if (existsSync(targetPath)) unlinkSync(targetPath);

  try {
    const input = {
      version: 'v1',
      ops: [{
        type: 'ADD_TABLE',
        tableName: 'phase14_test',
        columns: [{ name: 'id', type: 'TEXT', nullable: false }],
      }],
    };

    const result = executeProposalPipeline(
      input, uid(), 'phase14 ADD_TABLE integration test', Date.now(),
      { migrationTargetFile: targetFile },
    );

    assert.equal(result.status, 'committed', `pipeline must commit, got: ${result.status} — ${result.reason ?? ''}`);
    assert.ok(result.proposalIds && result.proposalIds.length > 0, 'must have proposal IDs');

    // The migration file must have been created by the bootloader.
    assert.ok(existsSync(targetPath), 'migration file must exist after commit');
    const content = readFileSync(targetPath, 'utf8');
    assert.ok(content.includes('CREATE TABLE IF NOT EXISTS phase14_test'), 'file must contain the DDL');
  } finally {
    if (existsSync(targetPath)) unlinkSync(targetPath);
  }
}

// ─── 12. Pipeline: ADD_CAPABILITY → committed ────────────────────────────────
async function testPipelineAddCapability(): Promise<void> {
  const targetFile = 'src/migrations/9999_phase14_cap_test.sql';
  const targetPath = resolve(PROJECT_ROOT, targetFile);

  if (existsSync(targetPath)) unlinkSync(targetPath);

  try {
    const input = {
      version: 'v1',
      ops: [{ type: 'ADD_CAPABILITY', name: 'phase14_test_cap', description: 'Test capability' }],
    };

    const result = executeProposalPipeline(
      input, uid(), 'phase14 ADD_CAPABILITY integration test', Date.now(),
      { migrationTargetFile: targetFile },
    );

    assert.equal(result.status, 'committed', `pipeline must commit, got: ${result.status} — ${result.reason ?? ''}`);
    assert.ok(existsSync(targetPath), 'capability migration file must exist after commit');
    const content = readFileSync(targetPath, 'utf8');
    assert.ok(content.includes('phase14_test_cap'), 'file must contain the capability name');
  } finally {
    if (existsSync(targetPath)) unlinkSync(targetPath);
  }
}

// ─── 13. Pipeline: invalid input → validation_error ──────────────────────────
async function testPipelineValidationError(): Promise<void> {
  const badInput = { version: 'v1' }; // missing ops
  const result = executeProposalPipeline(
    badInput, uid(), 'should fail validation', Date.now(),
  );
  assert.equal(result.status, 'validation_error', 'missing ops must return validation_error');
  assert.ok(result.reason, 'must include a reason string');
}

// ─── 14. Deterministic replay ─────────────────────────────────────────────────
async function testDeterministicReplay(): Promise<void> {
  const input = {
    version: 'v1',
    ops: [
      { type: 'ADD_TABLE', tableName: 'replay_test', columns: [{ name: 'x', type: 'INTEGER' }] },
    ],
  };
  const diff = ProposalDiffV1Schema.parse(input);

  // Compile twice — output must be byte-for-byte identical.
  const art1 = compileProposal(diff);
  const art2 = compileProposal(diff);
  assert.deepEqual(art1, art2, 'compiler must be deterministic: same input → identical output');
  assert.equal(JSON.stringify(art1), JSON.stringify(art2), 'JSON serialization must be identical');
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ['reject unknown op type',        testRejectUnknownOp],
    ['reject extra fields (strict)',   testRejectExtraFields],
    ['reject missing required fields', testRejectMissingFields],
    ['reject empty ops array',         testRejectEmptyOps],
    ['reject wrong version string',    testRejectWrongVersion],
    ['ADD_TRANSITION compiles',        testCompileAddTransition],
    ['ADD_TABLE compiles',             testCompileAddTable],
    ['ADD_CAPABILITY compiles',        testCompileAddCapability],
    ['REVOKE_CAPABILITY compiles',     testCompileRevokeCapability],
    ['multiple ops accumulate',        testMultipleOps],
    ['pipeline ADD_TABLE → committed',      testPipelineAddTable],
    ['pipeline ADD_CAPABILITY → committed',  testPipelineAddCapability],
    ['pipeline invalid input → error',      testPipelineValidationError],
    ['deterministic replay',               testDeterministicReplay],
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
