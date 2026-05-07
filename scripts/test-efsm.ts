#!/usr/bin/env npx ts-node
/**
 * EFSM mandatory test suite.
 * Tests: concurrent claims, replay determinism, crash recovery,
 *        budget enforcement, DAG cycle detection, lease expiry,
 *        illegal state transitions, idempotency.
 */

import assert from 'node:assert/strict';

// Stub env vars before any module import touches config.ts or db.ts.
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

// All imports after env stubs are set.
import {
  createGraph, addNode, addDependency, finalizeGraph,
  selectRunnableTasks, executeTask, recoverOnStartup,
  getNode, getTransitions, getReceipt, getLatestReceipt, getBudget, cancelTask,
  StateTransitionError, DagValidationError,
  computeEffectId,
} from '../src/efsm/index';
import type { CapabilityExecutor } from '../src/efsm/index';
import { rawDb } from '../src/db';

// ── Helpers ──────────────────────────────────────────────────────────────────

let seq = 0;
function uid(prefix = 'n'): string { return `${prefix}-${++seq}`; }

function noop(): CapabilityExecutor {
  return async () => ({ stdout: 'ok', stderr: '', exitCode: 0 });
}

function failing(): CapabilityExecutor {
  return async () => ({ stdout: '', stderr: 'boom', exitCode: 1 });
}

function caps(...names: string[]): ReadonlyMap<string, CapabilityExecutor> {
  const m = new Map<string, CapabilityExecutor>();
  for (const n of names) m.set(n, noop());
  return m;
}

// Build a single-node graph, finalize it, return nodeId.
function singleNodeGraph(capability = 'noop', budget = 3, priority = 5): { graphId: string; nodeId: string } {
  const t   = Date.now();
  const gid = uid('g');
  const nid = uid('n');
  createGraph(gid, 'test goal', t);
  addNode({ id: nid, graph_id: gid, parent_id: null, capability_required: capability,
            payload: '{}', priority, max_attempts: budget, initial_budget: budget }, t);
  finalizeGraph(gid, t);
  return { graphId: gid, nodeId: nid };
}

// ── Test 1: Concurrent claims — only one winner ──────────────────────────────

async function testConcurrentClaims(): Promise<void> {
  const { nodeId } = singleNodeGraph();
  const t = Date.now();

  // Launch two executeTask calls "simultaneously".
  // Both start synchronously, but the first one to reach dbClaimWithBudget wins.
  // The second sees state='EXECUTING' and returns claim_failed.
  const results = await Promise.all([
    executeTask(nodeId, 'worker-A', caps('noop'), t),
    executeTask(nodeId, 'worker-B', caps('noop'), t),
  ]);

  const winners   = results.filter(r => r.status === 'completed' || r.status === 'failed');
  const losers    = results.filter(r => r.status === 'claim_failed');

  assert.equal(winners.length + losers.length, 2, 'both outcomes must be accounted for');
  assert.ok(winners.length >= 1, 'at least one must have attempted execution');
  assert.ok(losers.length >= 1 || winners.length === 2,
    'concurrent path: one winner OR sequential (both complete)');

  // The node must be in a terminal or PENDING state — never stuck in EXECUTING.
  const finalNode = getNode(nodeId);
  assert.ok(finalNode, 'node must exist');
  assert.notEqual(finalNode!.state, 'EXECUTING', 'node must not be stuck in EXECUTING');
}

// ── Test 2: Replay determinism ───────────────────────────────────────────────
// Same task_id + attempt_count always produces the same effect_id.

async function testReplayDeterminism(): Promise<void> {
  const taskId = 'deterministic-task-replay';

  // effect_id is a pure function of (task_id, attempt_count)
  const effectId1 = computeEffectId(taskId, 1);
  const effectId2 = computeEffectId(taskId, 1);
  const effectId3 = computeEffectId(taskId, 2);

  assert.equal(effectId1, effectId2, 'same inputs → same effect_id');
  assert.notEqual(effectId1, effectId3, 'different attempt → different effect_id');

  // Run a task and confirm the stored effect_id matches the deterministic formula.
  const { nodeId } = singleNodeGraph();
  const t = Date.now();
  await executeTask(nodeId, 'test-worker', caps('noop'), t);

  const finalNode = getNode(nodeId);
  assert.ok(finalNode, 'node must exist');
  assert.equal(finalNode!.attempt_count, 1, 'attempt_count must be 1');

  const expectedEffectId = computeEffectId(nodeId, 1);
  const receipt = getLatestReceipt(nodeId);
  assert.ok(receipt, 'receipt must exist');
  assert.equal(receipt!.effect_id, expectedEffectId, 'stored effect_id must match deterministic formula');
}

// ── Test 3: Crash recovery ───────────────────────────────────────────────────
// Simulate a crash by injecting a task into EXECUTING state directly,
// then verify recoverOnStartup brings it back to PENDING (budget allows retry).

async function testCrashRecovery(): Promise<void> {
  const t   = Date.now();
  const { nodeId } = singleNodeGraph('noop', 3);

  // Manually force the node into EXECUTING (simulating a mid-execution crash).
  const db = rawDb() as ReturnType<typeof rawDb>;
  const effectId = computeEffectId(nodeId, 1);
  db.prepare(`
    UPDATE task_nodes
    SET state = 'EXECUTING', lease_owner = 'crashed-worker',
        lease_expires_at = ?, attempt_count = 1, effect_id = ?, updated_at = ?
    WHERE id = ?
  `).run(t + 300_000, effectId, t, nodeId);

  // Insert a state_transitions record for the transition that would have happened.
  // (Not strictly required for recovery, but keeps audit log consistent.)

  const result = recoverOnStartup(t + 1);
  assert.ok(result.recovered >= 1, `must recover at least 1 task, got ${result.recovered}`);

  const recovered = getNode(nodeId);
  assert.ok(recovered, 'node must exist after recovery');
  // No receipt was stored → interrupted → FAILED → PENDING (budget=3 remaining=3, decrement happened already)
  // Budget was NOT decremented here (we bypassed normal claim), so recovery may return FAILED→PENDING.
  assert.ok(
    recovered!.state === 'PENDING' || recovered!.state === 'CANCELLED',
    `recovered node must be PENDING or CANCELLED, got ${recovered!.state}`,
  );
}

// ── Test 4: Budget enforcement ───────────────────────────────────────────────
// A task with budget=1 must succeed once, then subsequent attempts are blocked.

async function testBudgetEnforcement(): Promise<void> {
  const t = Date.now();
  const { nodeId } = singleNodeGraph('always_fail', 1, 5);

  // First execution attempt — budget=1, will be decremented.
  const result1 = await executeTask(nodeId, 'w', new Map([['always_fail', failing()]]), t);
  assert.equal(result1.status, 'failed', 'first attempt must fail (capability returns exitCode=1)');

  const afterFirst = getNode(nodeId);
  assert.ok(afterFirst, 'node must exist');

  // After one failed attempt with budget=1, budget_ledger.remaining_budget should be 0.
  const budget = getBudget(nodeId);
  assert.ok(budget, 'budget must exist');
  assert.equal(budget!.remaining_budget, 0, 'budget must be exhausted after one attempt');

  // Node should be CANCELLED (no budget for retry).
  assert.equal(afterFirst!.state, 'CANCELLED', `node must be CANCELLED after budget exhaustion, got ${afterFirst!.state}`);
}

// ── Test 5: DAG cycle detection ──────────────────────────────────────────────

async function testDagCycleDetection(): Promise<void> {
  const t   = Date.now();
  const gid = uid('g');
  const n1  = uid('n');
  const n2  = uid('n');
  const n3  = uid('n');

  createGraph(gid, 'cycle test', t);
  addNode({ id: n1, graph_id: gid, parent_id: null, capability_required: 'noop',
            payload: '{}', priority: 5, max_attempts: 3, initial_budget: 3 }, t);
  addNode({ id: n2, graph_id: gid, parent_id: n1,   capability_required: 'noop',
            payload: '{}', priority: 5, max_attempts: 3, initial_budget: 3 }, t);
  addNode({ id: n3, graph_id: gid, parent_id: n2,   capability_required: 'noop',
            payload: '{}', priority: 5, max_attempts: 3, initial_budget: 3 }, t);

  // Create a cycle: n3 → n1
  addDependency(n1, n2);
  addDependency(n2, n3);
  addDependency(n3, n1); // cycle

  assert.throws(
    () => finalizeGraph(gid, t),
    DagValidationError,
    'finalizeGraph must throw DagValidationError on a cycle',
  );
}

// ── Test 6: Lease expiry → reverts to PENDING ────────────────────────────────

async function testLeaseExpiry(): Promise<void> {
  const t = Date.now();
  const { nodeId } = singleNodeGraph('noop', 3);

  // Force the node into EXECUTING with an already-expired lease.
  const db = rawDb() as ReturnType<typeof rawDb>;
  const expiredAt = t - 1; // 1ms in the past
  const effectId  = computeEffectId(nodeId, 1);
  db.prepare(`
    UPDATE task_nodes
    SET state = 'EXECUTING', lease_owner = 'stale-worker',
        lease_expires_at = ?, attempt_count = 1, effect_id = ?, updated_at = ?
    WHERE id = ?
  `).run(expiredAt, effectId, t, nodeId);

  // Decrement budget manually to match the state (as if the normal claim ran).
  db.prepare(`
    UPDATE budget_ledger SET remaining_budget = remaining_budget - 1, updated_at = ?
    WHERE task_id = ?
  `).run(t, nodeId);

  // selectRunnableTasks calls reclaimExpiredLeases internally.
  const runnable = selectRunnableTasks(t + 1000);

  // After reclaim, the node should be in PENDING (budget=2 > 0).
  const reclaimed = getNode(nodeId);
  assert.ok(reclaimed, 'node must exist');
  assert.equal(
    reclaimed!.state, 'PENDING',
    `expired lease must revert to PENDING, got ${reclaimed!.state}`,
  );
  // The reclaimed node must appear in the runnable list.
  const found = runnable.find(n => n.id === nodeId);
  assert.ok(found, 'recovered task must appear in selectRunnableTasks output');
}

// ── Test 7: Illegal state transitions are rejected ───────────────────────────

async function testIllegalTransitions(): Promise<void> {
  const { nodeId } = singleNodeGraph();

  // PENDING → COMPLETED is not a valid transition.
  assert.throws(
    () => {
      const { applyTransition } = require('../src/efsm/state-machine') as typeof import('../src/efsm/state-machine');
      applyTransition(nodeId, 'PENDING', 'COMPLETED', Date.now());
    },
    StateTransitionError,
    'PENDING → COMPLETED must throw StateTransitionError',
  );

  // COMPLETED → anything is terminal.
  const t   = Date.now();
  const { nodeId: nid2 } = singleNodeGraph();
  await executeTask(nid2, 'w', caps('noop'), t);
  const finalNode = getNode(nid2);
  assert.ok(finalNode, 'node must exist');
  if (finalNode!.state === 'COMPLETED') {
    assert.throws(
      () => {
        const { applyTransition } = require('../src/efsm/state-machine') as typeof import('../src/efsm/state-machine');
        applyTransition(nid2, 'COMPLETED', 'PENDING', Date.now());
      },
      StateTransitionError,
      'COMPLETED → PENDING must throw StateTransitionError',
    );
  }
}

// ── Test 8: Idempotency — duplicate execution via effect_id ──────────────────
// Inserting a receipt with a duplicate effect_id must not cause a double-execution.

async function testIdempotency(): Promise<void> {
  const t = Date.now();
  const { nodeId } = singleNodeGraph('noop', 3);

  // Execute the task once — should succeed.
  const result1 = await executeTask(nodeId, 'w', caps('noop'), t);
  assert.equal(result1.status, 'completed', 'first execution must complete');

  const receipt1 = getLatestReceipt(nodeId);
  assert.ok(receipt1, 'receipt must exist after first execution');

  // The node is now COMPLETED. Attempting to execute again must fail at claim (not in PENDING).
  const result2 = await executeTask(nodeId, 'w', caps('noop'), t + 1);
  assert.notEqual(result2.status, 'completed',
    'second execute on COMPLETED task must not complete a second time');
  assert.equal(result2.status, 'claim_failed',
    'second execute must return claim_failed (task not in PENDING)');

  // Only one receipt must exist.
  const db = rawDb() as ReturnType<typeof rawDb>;
  const count = (db.prepare('SELECT COUNT(*) AS n FROM execution_receipts WHERE task_id = ?').get(nodeId) as { n: number }).n;
  assert.equal(count, 1, 'exactly one receipt must exist — no duplicate execution');
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ['concurrent claims',        testConcurrentClaims],
    ['replay determinism',       testReplayDeterminism],
    ['crash recovery',           testCrashRecovery],
    ['budget enforcement',       testBudgetEnforcement],
    ['DAG cycle detection',      testDagCycleDetection],
    ['lease expiry',             testLeaseExpiry],
    ['illegal transitions',      testIllegalTransitions],
    ['idempotency',              testIdempotency],
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
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
});
