/**
 * Phase 8 — Attention Field unit tests (10 cases).
 * Run: npm run build && node --experimental-strip-types scripts/test-attention.ts
 */

// Stub env vars so config / db initialise without crashing
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const attention = require('../dist/attention') as typeof import('../src/attention');

const {
  getAttentionWeight,
  computeFinalScore,
  MemoryNodeSchema,
  MIN_WEIGHT,
  MAX_WEIGHT,
  DECAY_HALF_LIFE_HOURS,
} = attention;

type MemoryNode = import('../src/attention').MemoryNode;

let passed = 0;
let failed = 0;

function run(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  [PASS] ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  [FAIL] ${name}: ${msg}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
  const base: MemoryNode = {
    id:                  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    agent_id:            'test-agent',
    salience:            0.8,
    importance:          0.7,
    reinforcement_count: 1,
    last_reinforced_at:  1_000_000,
    created_at_epoch:    1_000_000,
  };
  return { ...base, ...overrides };
}

// ── Test 1: decay correctness ──────────────────────────────────────────────
run('decay after exactly one half-life returns ~0.5 × gain(1)', () => {
  const halfLifeMs = DECAY_HALF_LIFE_HOURS * 3_600_000;
  const now = 1_000_000 + halfLifeMs;
  const node = makeNode({ reinforcement_count: 1, last_reinforced_at: 1_000_000 });
  const w = getAttentionWeight(node, now);
  const expected = 0.5 * Math.log10(1 + 10);
  assert(Math.abs(w - expected) < 0.001,
    `Expected ~${expected.toFixed(4)}, got ${w.toFixed(4)}`);
});

// ── Test 2: gain grows with reinforcement count ────────────────────────────
run('higher reinforcement_count produces higher weight (same age)', () => {
  const now = 2_000_000;
  const wA = getAttentionWeight(makeNode({ reinforcement_count: 1,   last_reinforced_at: 1_000_000 }), now);
  const wB = getAttentionWeight(makeNode({ reinforcement_count: 100, last_reinforced_at: 1_000_000 }), now);
  assert(wB > wA, `gain(100) should exceed gain(1): wA=${wA.toFixed(4)} wB=${wB.toFixed(4)}`);
});

// ── Test 3: weight floor is MIN_WEIGHT ────────────────────────────────────
run('weight never falls below MIN_WEIGHT even for very old nodes', () => {
  const now = 1_000_000 + 1_000_000_000; // ~11.6 days >> 72h half-life
  const w = getAttentionWeight(makeNode({ reinforcement_count: 1, last_reinforced_at: 1_000_000 }), now);
  assert(w >= MIN_WEIGHT, `weight=${w} below floor ${MIN_WEIGHT}`);
});

// ── Test 4: weight ceiling is MAX_WEIGHT ──────────────────────────────────
run('weight never exceeds MAX_WEIGHT for extreme reinforcement counts', () => {
  const w = getAttentionWeight(makeNode({ reinforcement_count: 1_000_000, last_reinforced_at: 1_000_000 }), 1_000_001);
  assert(w <= MAX_WEIGHT, `weight=${w} exceeds ceiling ${MAX_WEIGHT}`);
});

// ── Test 5: NaN last_reinforced_at is protected ───────────────────────────
run('getAttentionWeight returns finite ≥ MIN_WEIGHT when last_reinforced_at is NaN', () => {
  const w = getAttentionWeight(makeNode({ last_reinforced_at: NaN as unknown as number }), 1_500_000);
  assert(isFinite(w) && w >= MIN_WEIGHT, `Expected finite ≥ ${MIN_WEIGHT}, got ${w}`);
});

// ── Test 6: Infinity base is protected ────────────────────────────────────
run('computeFinalScore returns 0 when base is Infinity', () => {
  const score = computeFinalScore(Infinity, 2.5);
  assert(score === 0, `Expected 0, got ${score}`);
});

// ── Test 7: negative base passes through unchanged ────────────────────────
run('computeFinalScore does not modify negative base scores', () => {
  const score = computeFinalScore(-0.3, 5.0);
  assert(score === -0.3, `Expected -0.3, got ${score}`);
});

// ── Test 8: positive base is scaled by weight ─────────────────────────────
run('computeFinalScore scales positive base by weight', () => {
  const score = computeFinalScore(0.4, 2.5);
  assert(Math.abs(score - 1.0) < 1e-10, `Expected 1.0, got ${score}`);
});

// ── Test 9: Zod schema rejects missing id ─────────────────────────────────
run('MemoryNodeSchema rejects node without id field', () => {
  const result = MemoryNodeSchema.safeParse({
    agent_id:            'x',
    salience:            0.5,
    importance:          0.5,
    reinforcement_count: 1,
    last_reinforced_at:  1000,
    created_at_epoch:    1000,
  });
  assert(result.success === false, 'Expected safeParse to fail');
});

// ── Test 10: Zod schema rejects reinforcement_count < 1 ───────────────────
run('MemoryNodeSchema rejects reinforcement_count of 0', () => {
  const result = MemoryNodeSchema.safeParse(makeNode({ reinforcement_count: 0 }));
  assert(result.success === false, 'Expected safeParse to fail for count=0');
});

// ── Summary ───────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) {
  console.log(`[PASS] All ${passed} tests passed.`);
} else {
  console.error(`[FAIL] ${failed}/${passed + failed} tests failed.`);
  process.exit(1);
}
