/**
 * Phase 9 — Topology Evolution unit + concurrency tests.
 * Run: npm run build && node --experimental-strip-types scripts/test-topology.ts
 */

// Stub env vars before any imports
const STUBS: Record<string, string> = {
  ANTHROPIC_API_KEY:         'test-key',
  TELEGRAM_BOT_TOKEN:        'test',
  TELEGRAM_ALLOWED_CHAT_IDS: '1',
  GOOGLE_API_KEY:            'test',
  PIN_HASH:                  'test',
  KILL_PHRASE:               'test',
  DASHBOARD_TOKEN:           'test',
  PROJECT_ROOT:              process.cwd(),
  STORE_PATH:                ':memory:',
};
for (const [k, v] of Object.entries(STUBS)) {
  if (!process.env[k]) process.env[k] = v;
}

const {
  CENTROID_DIM,
  MIN_SPLIT_SIZE,
  FUSION_SIMILARITY_THRESHOLD,
  splitChildId,
  encodeCentroid,
  decodeCentroid,
  vecDot,
  vecCosineSimilarity,
  computeVariance,
  dominantEigenvector,
  canonicalizeSign,
  splitConcept,
  fuseConcepts,
  createRootConcept,
  validateTopology,
} = require('../dist/topology') as typeof import('../src/topology');

const { rawDb } = require('../dist/db') as typeof import('../src/db');

type DB = ReturnType<typeof rawDb>;

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (e: unknown) {
    console.error(`  [FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Returns a 768-dim Float64Array with value `val` at dim `d`, 0 elsewhere.
function makeVec(d: number, val: number): Float64Array {
  const v = new Float64Array(CENTROID_DIM);
  v[d] = val;
  return v;
}

// Insert a test memory with a controlled 768-dim JSON embedding.
function insertMemory(db: DB, id: string, embedding: Float64Array): void {
  const arr = Array.from(embedding);
  db.prepare(`
    INSERT INTO memories
      (id, chat_id, agent_id, summary, importance, salience, pinned, consolidated, embedding, created_at)
    VALUES (?, '1', 'test-agent', 'test', 0.5, 1.0, 0, 0, ?, '2024-01-01T00:00:00.000Z')
  `).run(id, JSON.stringify(arr));
}

// Insert a concept node directly (bypasses createRootConcept for test control).
function insertConcept(
  db: DB, id: string, centroid: number[], variance: number,
  memberCount: number, now: number,
): void {
  db.prepare(`
    INSERT INTO concept_nodes
      (id, agent_id, created_at, updated_at, centroid, variance, member_count)
    VALUES (?, 'test-agent', ?, ?, ?, ?, ?)
  `).run(id, now, now, encodeCentroid(centroid), variance, memberCount);
}

// Add a concept_membership row.
function insertMembership(db: DB, memId: string, conceptId: string, now: number): void {
  db.prepare(`
    INSERT INTO concept_membership (memory_id, concept_id, assigned_at) VALUES (?, ?, ?)
  `).run(memId, conceptId, now);
}

// Zero centroid (768 zeros) for generic concept setup.
function zeroCentroid(): number[] {
  return new Array(CENTROID_DIM).fill(0);
}

// Build a concept + 32 member memories for split tests.
// Memory IDs are prefixed with the first 5 chars of conceptId to avoid
// UNIQUE collisions when multiple tests share the same in-memory DB.
// Group A: 16 memories with dim 0 = +1.0
// Group B: 16 memories with dim 0 = -1.0
// Centroid = [0, 0, ...], variance = 1.0 > SPLIT_VARIANCE_THRESHOLD.
function setupSplittableConcept(db: DB, conceptId: string, now: number): void {
  const px = conceptId.slice(0, 5);
  insertConcept(db, conceptId, zeroCentroid(), 1.0, 32, now);

  for (let i = 1; i <= 16; i++) {
    const id = `${px}p${String(i).padStart(2, '0')}`;
    insertMemory(db, id, makeVec(0, 1.0));
    insertMembership(db, id, conceptId, now);
  }
  for (let i = 1; i <= 16; i++) {
    const id = `${px}n${String(i).padStart(2, '0')}`;
    insertMemory(db, id, makeVec(0, -1.0));
    insertMembership(db, id, conceptId, now);
  }
}

// Reset split state so the same concept can be split again deterministically.
// Order matters: free FK-referencing memberships before deleting child nodes.
function resetSplit(db: DB, conceptId: string, leftId: string, rightId: string, now: number): void {
  // 1. Restore memberships to parent first — child nodes still exist as FK targets
  db.prepare(`
    UPDATE concept_membership SET concept_id = ?, assigned_at = ?
    WHERE concept_id IN (?, ?)
  `).run(conceptId, now, leftId, rightId);
  // 2. Remove lineage entries that reference the parent (parent concept survives)
  db.prepare(`DELETE FROM concept_lineage WHERE parent_id = ?`).run(conceptId);
  // 3. Safe to delete child nodes now (no FK references remain)
  db.prepare(`DELETE FROM concept_nodes WHERE id IN (?, ?)`).run(leftId, rightId);
  // 4. Reset parent state
  db.prepare(`
    UPDATE concept_nodes SET last_split_at = NULL, member_count = 32, updated_at = ? WHERE id = ?
  `).run(now, conceptId);
}

// ─── PCA Tests ───────────────────────────────────────────────────────────────

run('PCA: same matrix → same axis', () => {
  // 5 vectors in 3D, strongly spread along dim 0
  const vecs = [
    new Float64Array([2, 0.1, 0]),
    new Float64Array([2, -0.1, 0]),
    new Float64Array([-2, 0.1, 0]),
    new Float64Array([-2, -0.1, 0]),
    new Float64Array([1.5, 0, 0]),
  ];
  const a1 = dominantEigenvector(vecs, 3);
  const a2 = dominantEigenvector(vecs, 3);
  assert(a1 !== null && a2 !== null, 'expected non-null axis');
  for (let i = 0; i < 3; i++) {
    assert(Math.abs(a1![i] - a2![i]) < 1e-12,
      `component ${i} differs: ${a1![i]} vs ${a2![i]}`);
  }
});

run('PCA: sign canonicalization invariant (negation round-trips)', () => {
  const original = new Float64Array([-0.8, 0.6, 0]);
  const canon1 = canonicalizeSign(original);
  assert(canon1 !== null, 'expected non-null');
  // Negate the result and re-canonicalize — must give the same output
  const negated = new Float64Array(canon1!.map(x => -x));
  const canon2 = canonicalizeSign(negated);
  assert(canon2 !== null, 'expected non-null after negation');
  for (let i = 0; i < 3; i++) {
    assert(Math.abs(canon1![i] - canon2![i]) < 1e-12,
      `component ${i} differs after negation+canonicalize`);
  }
  // First non-zero component must be positive
  assert(canon1![0] > 0, 'first component must be positive');
});

run('PCA: zero axis → dominantEigenvector returns null', () => {
  // All-zero centered vectors → degenerate covariance → null
  const zeroVecs = Array.from({ length: 5 }, () => new Float64Array(3));
  const axis = dominantEigenvector(zeroVecs, 3);
  assert(axis === null, 'expected null for zero-covariance matrix');
});

// ─── Split Tests ─────────────────────────────────────────────────────────────

run('Split: deterministic partition replay', () => {
  const db   = rawDb() as DB;
  const cId  = 'deter-0000-0000-0000-000000000001';
  const now  = 1_000_000;
  setupSplittableConcept(db, cId, now);

  const ok1 = splitConcept(cId, now);
  assert(ok1, 'first split should succeed');

  const lId = splitChildId(cId, 'L', now);
  const rId = splitChildId(cId, 'R', now);

  // Collect partition from run 1
  const leftMembers1  = (db.prepare(`SELECT memory_id FROM concept_membership WHERE concept_id = ? ORDER BY memory_id`).all(lId) as Array<{memory_id:string}>).map(r => r.memory_id);
  const rightMembers1 = (db.prepare(`SELECT memory_id FROM concept_membership WHERE concept_id = ? ORDER BY memory_id`).all(rId) as Array<{memory_id:string}>).map(r => r.memory_id);

  resetSplit(db, cId, lId, rId, now);

  const ok2 = splitConcept(cId, now);
  assert(ok2, 'second split should succeed after reset');

  const leftMembers2  = (db.prepare(`SELECT memory_id FROM concept_membership WHERE concept_id = ? ORDER BY memory_id`).all(lId) as Array<{memory_id:string}>).map(r => r.memory_id);
  const rightMembers2 = (db.prepare(`SELECT memory_id FROM concept_membership WHERE concept_id = ? ORDER BY memory_id`).all(rId) as Array<{memory_id:string}>).map(r => r.memory_id);

  assert(JSON.stringify(leftMembers1)  === JSON.stringify(leftMembers2),  'left partition must be identical');
  assert(JSON.stringify(rightMembers1) === JSON.stringify(rightMembers2), 'right partition must be identical');
});

run('Split: midpoint tie determinism — lex-smaller id assigned to left', () => {
  // 30 vectors (15 at -1, 15 at +1) + 2 tie vectors at 0 with ids "tie-a", "tie-b".
  // Sorted: 15 negatives, tie-a, tie-b, 15 positives.
  // Mid = 16: left gets 15 negatives + tie-a; right gets tie-b + 15 positives.
  const db  = rawDb() as DB;
  const cId = 'tieid-000-0000-0000-000000000001';
  const now = 2_000_000;

  insertConcept(db, cId, zeroCentroid(), 0.9375, 32, now);

  for (let i = 1; i <= 15; i++) {
    const id = `neg-t-${String(i).padStart(2, '0')}`;
    insertMemory(db, id, makeVec(0, -1.0));
    insertMembership(db, id, cId, now);
  }
  insertMemory(db, 'tie-a', makeVec(0, 0.0));
  insertMembership(db, 'tie-a', cId, now);
  insertMemory(db, 'tie-b', makeVec(0, 0.0));
  insertMembership(db, 'tie-b', cId, now);
  for (let i = 1; i <= 15; i++) {
    const id = `pos-t-${String(i).padStart(2, '0')}`;
    insertMemory(db, id, makeVec(0, 1.0));
    insertMembership(db, id, cId, now);
  }

  assert(splitConcept(cId, now), 'split should succeed');

  const lId = splitChildId(cId, 'L', now);
  const rId = splitChildId(cId, 'R', now);

  const inLeft  = db.prepare(`SELECT 1 FROM concept_membership WHERE concept_id = ? AND memory_id = 'tie-a'`).get(lId);
  const inRight = db.prepare(`SELECT 1 FROM concept_membership WHERE concept_id = ? AND memory_id = 'tie-b'`).get(rId);

  assert(inLeft  !== undefined, 'tie-a (lex smaller) must be in left partition');
  assert(inRight !== undefined, 'tie-b (lex larger) must be in right partition');
});

run('Split: invalid child abort — no partial writes when valid vectors < MIN_SPLIT_SIZE', () => {
  const db  = rawDb() as DB;
  const cId = 'abort-000-0000-0000-000000000001';
  const now = 3_000_000;

  // concept says 32 members but only 6 will have parseable embeddings
  insertConcept(db, cId, zeroCentroid(), 1.0, 32, now);
  for (let i = 1; i <= 6; i++) {
    const id = `sml-${i}`;
    insertMemory(db, id, makeVec(0, i % 2 === 0 ? 1.0 : -1.0));
    insertMembership(db, id, cId, now);
  }
  // 26 memberships pointing to non-existent memories (embedding will be NULL from JOIN)
  for (let i = 7; i <= 32; i++) {
    db.prepare(`INSERT INTO concept_membership (memory_id, concept_id, assigned_at) VALUES (?, ?, ?)`)
      .run(`ghost-${i}`, cId, now);
  }

  const ok = splitConcept(cId, now);
  assert(!ok, 'split should return false when valid vectors < MIN_SPLIT_SIZE');

  const newNodes = db.prepare(`SELECT id FROM concept_nodes WHERE id NOT IN (?)`).all(cId) as Array<{id:string}>;
  assert(
    !newNodes.some(r => r.id.includes(splitChildId(cId, 'L', now).slice(0, 8))),
    'no child concept nodes should be created',
  );
  const lineage = db.prepare(`SELECT id FROM concept_lineage WHERE parent_id = ?`).all(cId);
  assert((lineage as unknown[]).length === 0, 'no lineage entries should be created');
});

run('Split: lineage correctness', () => {
  const db  = rawDb() as DB;
  const cId = 'lineage-00-0000-0000-000000000001';
  const now = 4_000_000;
  setupSplittableConcept(db, cId, now);

  assert(splitConcept(cId, now), 'split should succeed');

  const lId = splitChildId(cId, 'L', now);
  const rId = splitChildId(cId, 'R', now);

  const lineage = db.prepare(`
    SELECT parent_id, event_type FROM concept_lineage WHERE parent_id = ?
  `).all(cId) as Array<{parent_id:string; event_type:string}>;

  assert(lineage.length === 2, `expected 2 lineage entries, got ${lineage.length}`);
  assert(lineage.every(r => r.parent_id === cId), 'all lineage entries must have correct parent_id');
  assert(lineage.every(r => r.event_type === 'split'), 'all lineage entries must have event_type=split');

  const parent = db.prepare(`SELECT member_count FROM concept_nodes WHERE id = ?`).get(cId) as {member_count:number};
  assert(parent.member_count === 0, 'parent member_count must be 0 after split');

  const left  = db.prepare(`SELECT member_count FROM concept_nodes WHERE id = ?`).get(lId) as {member_count:number};
  const right = db.prepare(`SELECT member_count FROM concept_nodes WHERE id = ?`).get(rId) as {member_count:number};
  assert(left.member_count + right.member_count === 32, 'children must account for all 32 members');
});

// ─── Fusion Tests ────────────────────────────────────────────────────────────

run('Fusion: similarity threshold pass → concepts are merged', () => {
  const db  = rawDb() as DB;
  const now = 5_000_000;
  const idA = 'fusea-000-0000-0000-000000000001';
  const idB = 'fuseb-000-0000-0000-000000000001';

  // Nearly parallel centroids: cos ≈ 0.9994 > 0.985
  const cA = zeroCentroid(); cA[0] = 1.0;
  const cB = zeroCentroid(); cB[0] = 0.9992; cB[1] = 0.04;

  insertConcept(db, idA, cA, 0.1, 3, now);
  insertConcept(db, idB, cB, 0.1, 2, now - 1000);

  const ok = fuseConcepts(idA, idB, now);
  assert(ok, 'fusion should succeed for similar centroids');

  const loser = db.prepare(`SELECT tombstoned FROM concept_nodes WHERE id = ?`).get(idA) as {tombstoned:number};
  // idB was created earlier (smaller created_at), so idB is winner
  assert(loser.tombstoned === 1, 'older created_at wins — idA (newer) must be tombstoned');
});

run('Fusion: threshold fail → no merge', () => {
  const db  = rawDb() as DB;
  const now = 6_000_000;
  const idA = 'faila-000-0000-0000-000000000001';
  const idB = 'failb-000-0000-0000-000000000001';

  // Orthogonal centroids: cos = 0 < 0.985
  const cA = zeroCentroid(); cA[0] = 1.0;
  const cB = zeroCentroid(); cB[1] = 1.0;

  insertConcept(db, idA, cA, 0.1, 2, now);
  insertConcept(db, idB, cB, 0.1, 2, now);

  assert(!fuseConcepts(idA, idB, now), 'fusion must fail for dissimilar centroids');

  const a = db.prepare(`SELECT tombstoned FROM concept_nodes WHERE id = ?`).get(idA) as {tombstoned:number};
  const b = db.prepare(`SELECT tombstoned FROM concept_nodes WHERE id = ?`).get(idB) as {tombstoned:number};
  assert(a.tombstoned === 0 && b.tombstoned === 0, 'neither concept should be tombstoned');
});

run('Fusion: oldest concept survives', () => {
  const db  = rawDb() as DB;
  const now = 7_000_000;
  const idA = 'olda0-000-0000-0000-000000000001';  // older
  const idB = 'oldb0-000-0000-0000-000000000001';  // newer

  const c = zeroCentroid(); c[0] = 1.0;

  insertConcept(db, idA, c, 0.0, 1, 1000);        // created_at = 1000 (older)
  insertConcept(db, idB, c, 0.0, 1, 2000);        // created_at = 2000 (newer)

  assert(fuseConcepts(idA, idB, now), 'fusion should succeed');

  const a = db.prepare(`SELECT tombstoned FROM concept_nodes WHERE id = ?`).get(idA) as {tombstoned:number};
  const b = db.prepare(`SELECT tombstoned FROM concept_nodes WHERE id = ?`).get(idB) as {tombstoned:number};
  assert(a.tombstoned === 0, 'idA (older, created_at=1000) must survive');
  assert(b.tombstoned === 1, 'idB (newer, created_at=2000) must be tombstoned');
});

run('Fusion: same created_at → lex-smaller id survives', () => {
  const db  = rawDb() as DB;
  const now = 8_000_000;
  const idA = 'aaaa0-000-0000-0000-000000000001';  // lex smaller
  const idB = 'zzzz0-000-0000-0000-000000000001';  // lex larger

  const c = zeroCentroid(); c[0] = 1.0;

  insertConcept(db, idA, c, 0.0, 1, 1000);
  insertConcept(db, idB, c, 0.0, 1, 1000);  // same created_at

  assert(fuseConcepts(idA, idB, now), 'fusion should succeed');

  const a = db.prepare(`SELECT tombstoned FROM concept_nodes WHERE id = ?`).get(idA) as {tombstoned:number};
  const b = db.prepare(`SELECT tombstoned FROM concept_nodes WHERE id = ?`).get(idB) as {tombstoned:number};
  assert(a.tombstoned === 0, 'lex-smaller id must survive');
  assert(b.tombstoned === 1, 'lex-larger id must be tombstoned');
});

run('Fusion: membership conservation — all loser members reassigned', () => {
  const db  = rawDb() as DB;
  const now = 9_000_000;
  const idA = 'consA-000-0000-0000-000000000001';
  const idB = 'consB-000-0000-0000-000000000001';

  const c = zeroCentroid(); c[0] = 1.0;
  insertConcept(db, idA, c, 0.1, 3, 1000);
  insertConcept(db, idB, c, 0.1, 2, 2000);

  for (let i = 1; i <= 3; i++) {
    const id = `consA-mem-${i}`;
    insertMemory(db, id, makeVec(0, 1.0));
    insertMembership(db, id, idA, now);
  }
  for (let i = 1; i <= 2; i++) {
    const id = `consB-mem-${i}`;
    insertMemory(db, id, makeVec(0, 1.0));
    insertMembership(db, id, idB, now);
  }

  assert(fuseConcepts(idA, idB, now), 'fusion should succeed');

  // idA (created_at=1000) is winner
  const winnerCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM concept_membership WHERE concept_id = ?`
  ).get(idA) as {cnt:number};
  assert(winnerCount.cnt === 5, `expected 5 members in winner, got ${winnerCount.cnt}`);

  const loserCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM concept_membership WHERE concept_id = ?`
  ).get(idB) as {cnt:number};
  assert(loserCount.cnt === 0, 'loser must have 0 memberships after fusion');
});

// ─── Transaction / Serialization Tests ───────────────────────────────────────

run('Transactions: rollback integrity — ineligible concept leaves no writes', () => {
  const db  = rawDb() as DB;
  const cId = 'ineli-000-0000-0000-000000000001';
  const now = 10_000_000;

  // variance below threshold
  insertConcept(db, cId, zeroCentroid(), 0.1, 32, now);

  const nodesBefore = (db.prepare(`SELECT id FROM concept_nodes`).all() as Array<{id:string}>).length;
  const linBefore   = (db.prepare(`SELECT id FROM concept_lineage`).all() as Array<{id:string}>).length;

  assert(!splitConcept(cId, now), 'split should return false');

  const nodesAfter = (db.prepare(`SELECT id FROM concept_nodes`).all() as Array<{id:string}>).length;
  const linAfter   = (db.prepare(`SELECT id FROM concept_lineage`).all() as Array<{id:string}>).length;

  assert(nodesAfter === nodesBefore, 'no new concept_nodes should be written');
  assert(linAfter   === linBefore,   'no new lineage entries should be written');
});

run('Transactions: no partial writes — after split all state is consistent', () => {
  const db  = rawDb() as DB;
  const cId = 'npw00-000-0000-0000-000000000001';
  const now = 11_000_000;
  setupSplittableConcept(db, cId, now);

  assert(splitConcept(cId, now), 'split must succeed');

  const lId = splitChildId(cId, 'L', now);
  const rId = splitChildId(cId, 'R', now);

  // Both children must exist
  assert(db.prepare(`SELECT id FROM concept_nodes WHERE id = ?`).get(lId) !== undefined, 'left child must exist');
  assert(db.prepare(`SELECT id FROM concept_nodes WHERE id = ?`).get(rId) !== undefined, 'right child must exist');

  // All 32 memberships must be reassigned (none still pointing at parent)
  const parentMemberships = db.prepare(
    `SELECT COUNT(*) AS cnt FROM concept_membership WHERE concept_id = ?`
  ).get(cId) as {cnt:number};
  assert(parentMemberships.cnt === 0, 'parent must have 0 memberships after split');

  // Children together account for all 32
  const lCount = (db.prepare(`SELECT COUNT(*) AS cnt FROM concept_membership WHERE concept_id = ?`).get(lId) as {cnt:number}).cnt;
  const rCount = (db.prepare(`SELECT COUNT(*) AS cnt FROM concept_membership WHERE concept_id = ?`).get(rId) as {cnt:number}).cnt;
  assert(lCount + rCount === 32, `expected 32 total memberships, got ${lCount + rCount}`);
});

run('Transactions: concurrent split attempts serialize — second is blocked', () => {
  const db  = rawDb() as DB;
  const cId = 'conc0-000-0000-0000-000000000001';
  const now = 12_000_000;
  setupSplittableConcept(db, cId, now);

  const first  = splitConcept(cId, now);
  // After first split: parent member_count = 0 → second attempt fails on size guard.
  // In a multi-writer scenario the BEGIN IMMEDIATE lock would also serialize attempts.
  const second = splitConcept(cId, now);

  assert(first,   'first split must succeed');
  assert(!second, 'second split must be rejected (parent emptied by first split)');

  // Exactly two child nodes — no duplicates from a phantom second split
  const lId = splitChildId(cId, 'L', now);
  const rId = splitChildId(cId, 'R', now);
  const children = db.prepare(`
    SELECT id FROM concept_nodes WHERE id IN (?, ?)
  `).all(lId, rId) as Array<{id:string}>;
  assert(children.length === 2, 'exactly 2 children must exist');
});

// ─── Numeric Guard Tests ──────────────────────────────────────────────────────

run('Numeric: NaN in embedding is skipped — too few valid vectors → split aborted', () => {
  const db  = rawDb() as DB;
  const cId = 'nana0-000-0000-0000-000000000001';
  const now = 13_000_000;

  insertConcept(db, cId, zeroCentroid(), 1.0, 32, now);

  // Insert 32 memories: 31 have NaN embeddings, 1 valid
  for (let i = 1; i <= 31; i++) {
    const arr = new Array(CENTROID_DIM).fill(NaN);
    db.prepare(`
      INSERT INTO memories
        (id, chat_id, agent_id, summary, importance, salience, pinned, consolidated, embedding, created_at)
      VALUES (?, '1', 'test-agent', 'test', 0.5, 1.0, 0, 0, ?, '2024-01-01')
    `).run(`nan-${i}`, JSON.stringify(arr));
    insertMembership(db, `nan-${i}`, cId, now);
  }
  insertMemory(db, 'nan-valid', makeVec(0, 1.0));
  insertMembership(db, 'nan-valid', cId, now);

  assert(!splitConcept(cId, now), 'split must fail when valid vectors < MIN_SPLIT_SIZE');
});

run('Numeric: Infinity in embedding is skipped', () => {
  const db  = rawDb() as DB;
  const cId = 'infA0-000-0000-0000-000000000001';
  const now = 14_000_000;

  insertConcept(db, cId, zeroCentroid(), 1.0, 32, now);

  for (let i = 1; i <= 32; i++) {
    const arr = new Array(CENTROID_DIM).fill(0);
    arr[0] = Infinity; // will be JSON.stringify'd as null → invalid
    db.prepare(`
      INSERT INTO memories
        (id, chat_id, agent_id, summary, importance, salience, pinned, consolidated, embedding, created_at)
      VALUES (?, '1', 'test-agent', 'test', 0.5, 1.0, 0, 0, ?, '2024-01-01')
    `).run(`inf-${i}`, JSON.stringify(arr));
    insertMembership(db, `inf-${i}`, cId, now);
  }

  assert(!splitConcept(cId, now), 'split must fail when embeddings contain Infinity');
});

run('Numeric: dimension mismatch in embedding is rejected', () => {
  const db  = rawDb() as DB;
  const cId = 'dim00-000-0000-0000-000000000001';
  const now = 15_000_000;

  insertConcept(db, cId, zeroCentroid(), 1.0, 32, now);

  // All 32 embeddings have wrong dimension (3 instead of 768)
  for (let i = 1; i <= 32; i++) {
    db.prepare(`
      INSERT INTO memories
        (id, chat_id, agent_id, summary, importance, salience, pinned, consolidated, embedding, created_at)
      VALUES (?, '1', 'test-agent', 'test', 0.5, 1.0, 0, 0, ?, '2024-01-01')
    `).run(`dim-${i}`, JSON.stringify([1, 0, 0]));  // 3-dim, not 768-dim
    insertMembership(db, `dim-${i}`, cId, now);
  }

  assert(!splitConcept(cId, now), 'split must fail when all embeddings have wrong dimension');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('');
if (failed === 0) {
  console.log(`[PASS] All ${passed} tests passed.`);
} else {
  console.error(`[FAIL] ${failed}/${passed + failed} tests failed.`);
  process.exit(1);
}
