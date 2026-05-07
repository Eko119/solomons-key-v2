/**
 * Phase 10 — Motor Cortex unit + integration tests.
 * Run: npm run build && node --experimental-strip-types scripts/test-motor-cortex.ts
 */

// Stub env vars before any module code runs.
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

const fs          = require('node:fs')   as typeof import('node:fs');
const nodePath    = require('node:path') as typeof import('node:path');
const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
const os          = require('node:os')   as typeof import('node:os');

const {
  MAX_STDOUT_BYTES,
  MotorError,
  SandboxError,
  CapabilityError,
  canonicalizePath,
  assertInSandbox,
  hasCapability,
  assertCapability,
  grantCapability,
  getCommand,
  resetRegistry,
  executeCommand,
  getMcpServerStatus,
  validateMotorCortex,
} = require('../dist/motor-cortex') as typeof import('../src/motor-cortex');

const { rawDb } = require('../dist/db') as typeof import('../src/db');
type DB = ReturnType<typeof rawDb>;

// ─── test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

const tests: Array<{ name: string; fn: () => Promise<void> }> = [];

function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function throwsSync(fn: () => unknown, type: new (...a: unknown[]) => Error): void {
  try {
    fn();
    throw new Error(`expected ${type.name} but resolved normally`);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith('expected ')) throw e;
    if (!(e instanceof type)) {
      throw new Error(
        `expected ${type.name} but got ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`,
      );
    }
  }
}

async function rejects(
  fn: () => Promise<unknown>,
  type: new (...a: unknown[]) => Error,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ${type.name} but resolved normally`);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith('expected ')) throw e;
    if (!(e instanceof type)) {
      throw new Error(
        `expected ${type.name} but got ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`,
      );
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

let _sandbox: string | null = null;
function getSandbox(): string {
  if (!_sandbox) _sandbox = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'motor-test-'));
  return _sandbox;
}

function insertCommand(
  db:                 DB,
  id:                 string,
  command:            string,
  fixedArgs:          string[],
  argsSchemaType:     string,
  timeoutMs:          number,
  cwd:                string,
  envAllowlist:       string[],
  requiredCapability: string,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO command_registry
      (id, command, fixed_args_json, args_schema_type, timeout_ms, cwd,
       env_allowlist_json, required_capability, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, command, JSON.stringify(fixedArgs), argsSchemaType,
    timeoutMs, cwd, JSON.stringify(envAllowlist), requiredCapability, Date.now(),
  );
}

const AGENT = 'test-agent';

// ─── Filesystem ──────────────────────────────────────────────────────────────

test('Filesystem: canonicalizePath returns string for existing path', async () => {
  const sandbox = getSandbox();
  const resolved = canonicalizePath(sandbox);
  assert(typeof resolved === 'string' && resolved.length > 0, 'should return non-empty string');
});

test('Filesystem: canonicalizePath ancestor walk for non-existent sub-path', async () => {
  const sandbox = getSandbox();
  const deep = nodePath.join(sandbox, 'a', 'b', 'c', 'ghost.txt');
  const resolved = canonicalizePath(deep);
  assert(resolved.startsWith(sandbox), `expected prefix ${sandbox}, got ${resolved}`);
});

test('Filesystem: traversal rejected — path outside sandbox root', async () => {
  const sandbox = getSandbox();
  throwsSync(() => assertInSandbox('/etc/passwd', [sandbox]), SandboxError);
});

test('Filesystem: dotdot traversal rejected after canonicalization', async () => {
  const sandbox = getSandbox();
  // Resolve() collapses dotdots; result is outside sandbox.
  const escape = nodePath.resolve(sandbox, '..', '..', 'etc', 'passwd');
  throwsSync(() => assertInSandbox(escape, [sandbox]), SandboxError);
});

test('Filesystem: symlink escape rejected', async () => {
  const sandbox  = getSandbox();
  const linkPath = nodePath.join(sandbox, 'escape-link');
  try { fs.unlinkSync(linkPath); } catch { /* ok */ }
  fs.symlinkSync('/etc', linkPath);
  const resolved = canonicalizePath(nodePath.join(linkPath, 'passwd'));
  throwsSync(() => assertInSandbox(resolved, [sandbox]), SandboxError);
});

test('Filesystem: allowlisted path inside sandbox passes', async () => {
  const sandbox  = getSandbox();
  const filePath = nodePath.join(sandbox, 'safe.txt');
  fs.writeFileSync(filePath, 'ok');
  const resolved = canonicalizePath(filePath);
  assertInSandbox(resolved, [sandbox]);  // must not throw
});

test('Filesystem: sandbox root itself is allowed', async () => {
  const sandbox = getSandbox();
  assertInSandbox(sandbox, [sandbox]);  // must not throw
});

// ─── Shell injection prevention ──────────────────────────────────────────────

test('Shell: dollar-brace and backtick args treated as literals (no shell)', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'echo-literal-' + randomUUID();
  insertCommand(db, cmdId, '/bin/echo', [], 'any_strings', 5000, '/tmp', [], 'proc.exec');
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const result = await executeCommand({
    commandId: cmdId,
    args:      ['$(echo injected)', '`id`'],
    agentId:   AGENT,
  });
  // shell: false means the subshell is never invoked; exit 0 proves no error
  assert(result.exitCode === 0, `expected exit 0, got ${result.exitCode}`);
  assert(!result.timedOut, 'should not time out');
});

test('Shell: fixedArgs prepended — normalizedArgs contains only caller args', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'fixed-args-' + randomUUID();
  insertCommand(db, cmdId, '/bin/echo', ['fixed1', 'fixed2'], 'any_strings', 5000, '/tmp', [], 'proc.exec');
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const result = await executeCommand({
    commandId: cmdId,
    args:      ['user1', 'user2'],
    agentId:   AGENT,
  });
  assert(result.exitCode === 0, `expected exit 0, got ${result.exitCode}`);
  assert(
    JSON.stringify(result.normalizedArgs) === JSON.stringify(['user1', 'user2']),
    `expected ['user1','user2'], got ${JSON.stringify(result.normalizedArgs)}`,
  );
});

test('Shell: unregistered command rejected with MotorError', async () => {
  await rejects(
    () => executeCommand({ commandId: 'rm-rf-everything', args: [], agentId: AGENT }),
    MotorError,
  );
});

// ─── Capabilities ────────────────────────────────────────────────────────────

test('Capabilities: hasCapability false before grant, true after', async () => {
  const agentId = 'cap-agent-' + randomUUID();
  assert(!hasCapability(agentId, 'fs.read'),  'no capability initially');
  grantCapability(agentId, 'fs.read', 'test');
  assert(hasCapability(agentId, 'fs.read'),   'capability present after grant');
});

test('Capabilities: grantCapability is idempotent (INSERT OR IGNORE)', async () => {
  const agentId = 'idem-agent-' + randomUUID();
  grantCapability(agentId, 'fs.write', 'test');
  grantCapability(agentId, 'fs.write', 'test');  // must not throw
  assert(hasCapability(agentId, 'fs.write'), 'capability still held after duplicate grant');
});

test('Capabilities: assertCapability throws CapabilityError when missing', async () => {
  const agentId = 'missing-cap-' + randomUUID();
  throwsSync(() => assertCapability(agentId, 'proc.spawn'), CapabilityError);
});

test('Capabilities: unauthorized agent rejected on executeCommand', async () => {
  const db        = rawDb() as DB;
  const cmdId     = 'no-grant-cmd-' + randomUUID();
  const noGrant   = 'no-grant-agent-' + randomUUID();
  insertCommand(db, cmdId, '/bin/echo', ['hi'], 'none', 5000, '/tmp', [], 'proc.exec');
  resetRegistry();
  // Intentionally no grantCapability call.
  await rejects(
    () => executeCommand({ commandId: cmdId, args: [], agentId: noGrant }),
    CapabilityError,
  );
});

// ─── Registry immutability ───────────────────────────────────────────────────

test('Registry: immutable after first load — new DB row invisible until resetRegistry', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'immutable-cmd-' + randomUUID();
  resetRegistry();

  // Force a load with a known command
  assert(getCommand(cmdId) === undefined, 'command not in DB yet');

  // Insert AFTER registry is warmed
  insertCommand(db, cmdId, '/bin/echo', [], 'none', 5000, '/tmp', [], 'proc.exec');

  // Still cached — must not see the new command
  assert(getCommand(cmdId) === undefined, 'registry cached; new command must not appear');

  // After explicit reset it must appear
  resetRegistry();
  assert(getCommand(cmdId) !== undefined, 'post-reset: new command must appear');
});

// ─── Process execution ───────────────────────────────────────────────────────

test('Process: clean execution — exit 0, receipt in DB', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'clean-exec-' + randomUUID();
  insertCommand(db, cmdId, '/bin/echo', ['hello-world'], 'none', 5000, '/tmp', [], 'proc.exec');
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const result = await executeCommand({ commandId: cmdId, args: [], agentId: AGENT });
  assert(result.exitCode === 0,      `expected exit 0, got ${result.exitCode}`);
  assert(!result.timedOut,           'should not time out');
  assert(!result.truncated,          'should not be truncated');
  assert(result.stdoutHash.length === 64, 'stdout hash should be 64 hex chars');

  const row = (rawDb() as DB).prepare('SELECT id FROM execution_receipts WHERE id=?').get(result.id);
  assert(row !== undefined, 'receipt must be persisted in DB');
});

test('Process: timeout kills process and sets timedOut=true', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'timeout-cmd-' + randomUUID();
  insertCommand(db, cmdId, '/bin/sleep', [], 'any_strings', 200 /* ms */, '/tmp', [], 'proc.exec');
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const result = await executeCommand({ commandId: cmdId, args: ['60'], agentId: AGENT });
  assert(result.timedOut,      'must be marked timedOut');
  assert(result.exitCode !== 0, 'timed-out process should not exit 0');
});

test('Process: output truncation at MAX_STDOUT_BYTES', async () => {
  const db     = rawDb() as DB;
  const cmdId  = 'trunc-cmd-' + randomUUID();
  const bytes  = MAX_STDOUT_BYTES + 131072;  // 1 MiB + 128 KiB
  insertCommand(
    db, cmdId,
    '/usr/local/bin/python3',
    ['-c', `import sys; sys.stdout.buffer.write(b'A' * ${bytes})`],
    'none', 15000, '/tmp', [], 'proc.exec',
  );
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const result = await executeCommand({ commandId: cmdId, args: [], agentId: AGENT });
  assert(result.truncated, 'output should be marked truncated');
});

// ─── Sandbox enforcement via executeCommand ──────────────────────────────────

test('Security: fs capability without sandboxRoots rejected', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'no-sandbox-' + randomUUID();
  insertCommand(db, cmdId, '/bin/cat', [], 'single_path', 5000, '/tmp', [], 'fs.read');
  resetRegistry();
  grantCapability(AGENT, 'fs.read', 'test');

  await rejects(
    () => executeCommand({ commandId: cmdId, args: ['/tmp/x'], agentId: AGENT }),
    // sandboxRoots omitted → MotorError('NO_SANDBOX')
    MotorError,
  );
});

test('Security: CWD escape — arg outside sandboxRoots rejected', async () => {
  const db      = rawDb() as DB;
  const sandbox = getSandbox();
  const cmdId   = 'cwd-escape-' + randomUUID();
  insertCommand(db, cmdId, '/bin/cat', [], 'single_path', 5000, '/tmp', [], 'fs.read');
  resetRegistry();
  grantCapability(AGENT, 'fs.read', 'test');

  await rejects(
    () => executeCommand({
      commandId:    cmdId,
      args:         ['/etc/passwd'],
      agentId:      AGENT,
      sandboxRoots: [sandbox],
    }),
    SandboxError,
  );
});

test('Security: arbitrary binary rejected — not in command registry', async () => {
  await rejects(
    () => executeCommand({ commandId: '/bin/rm', args: ['-rf', '/'], agentId: AGENT }),
    MotorError,
  );
});

// ─── Env leakage prevention ───────────────────────────────────────────────────

test('Security: env leakage — secret not propagated to child process', async () => {
  const db        = rawDb() as DB;
  // Place a known secret in process.env.
  const secretKey = 'MOTOR_SECRET_' + randomUUID().replace(/-/g, '').toUpperCase();
  process.env[secretKey] = 'leak-value-alpha';

  const cmdId1 = 'env-leak-1-' + randomUUID();
  const cmdId2 = 'env-leak-2-' + randomUUID();
  // Empty envAllowlist — spawned child gets no vars.
  insertCommand(db, cmdId1, '/usr/bin/env', [], 'none', 5000, '/tmp', [], 'proc.exec');
  insertCommand(db, cmdId2, '/usr/bin/env', [], 'none', 5000, '/tmp', [], 'proc.exec');
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const r1 = await executeCommand({ commandId: cmdId1, args: [], agentId: AGENT });

  // Change the secret — if it leaked, r2.stdoutHash would differ from r1.stdoutHash.
  process.env[secretKey] = 'leak-value-beta';
  const r2 = await executeCommand({ commandId: cmdId2, args: [], agentId: AGENT });

  assert(
    r1.stdoutHash === r2.stdoutHash,
    'stdoutHash must be identical — proves env is empty (secret not propagated)',
  );
  delete process.env[secretKey];
});

// ─── Replay / determinism ─────────────────────────────────────────────────────

test('Replay: same command + args produce same stdout hash', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'replay-cmd-' + randomUUID();
  insertCommand(db, cmdId, '/bin/echo', ['deterministic'], 'none', 5000, '/tmp', [], 'proc.exec');
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const r1 = await executeCommand({ commandId: cmdId, args: [], agentId: AGENT });
  const r2 = await executeCommand({ commandId: cmdId, args: [], agentId: AGENT });

  assert(r1.stdoutHash === r2.stdoutHash, `hashes must match: ${r1.stdoutHash} vs ${r2.stdoutHash}`);
  assert(r1.commandId  === r2.commandId,  'commandId must match');
  assert(
    JSON.stringify(r1.normalizedArgs) === JSON.stringify(r2.normalizedArgs),
    'normalizedArgs must match',
  );
});

test('Receipt determinism: every execution gets a unique receipt ID', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'receipt-id-' + randomUUID();
  insertCommand(db, cmdId, '/bin/echo', ['unique'], 'none', 5000, '/tmp', [], 'proc.exec');
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const r1 = await executeCommand({ commandId: cmdId, args: [], agentId: AGENT });
  const r2 = await executeCommand({ commandId: cmdId, args: [], agentId: AGENT });

  assert(r1.id !== r2.id, 'each receipt must have a distinct UUID');
  const row1 = db.prepare('SELECT id FROM execution_receipts WHERE id=?').get(r1.id);
  const row2 = db.prepare('SELECT id FROM execution_receipts WHERE id=?').get(r2.id);
  assert(row1 !== undefined, 'first receipt must be in DB');
  assert(row2 !== undefined, 'second receipt must be in DB');
});

// ─── Concurrency ─────────────────────────────────────────────────────────────

test('Concurrency: 5 parallel executions all succeed with distinct receipt IDs', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'concurrent-' + randomUUID();
  insertCommand(db, cmdId, '/bin/echo', [], 'any_strings', 5000, '/tmp', [], 'proc.exec');
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      executeCommand({ commandId: cmdId, args: [`task-${i}`], agentId: AGENT }),
    ),
  );

  assert(results.length === 5,                           '5 results expected');
  assert(results.every(r => r.exitCode === 0),           'all must exit 0');
  assert(new Set(results.map(r => r.id)).size === 5,     'all receipt IDs must be distinct');
  for (const r of results) {
    const row = db.prepare('SELECT id FROM execution_receipts WHERE id=?').get(r.id);
    assert(row !== undefined, `receipt ${r.id} missing from DB`);
  }
});

test('Concurrency: receipt count consistent under parallel load (N=10)', async () => {
  const db    = rawDb() as DB;
  const cmdId = 'load-' + randomUUID();
  insertCommand(db, cmdId, '/bin/echo', ['load'], 'none', 5000, '/tmp', [], 'proc.exec');
  resetRegistry();
  grantCapability(AGENT, 'proc.exec', 'test');

  const N      = 10;
  const before = (db.prepare('SELECT COUNT(*) as c FROM execution_receipts').get() as { c: number }).c;

  await Promise.all(
    Array.from({ length: N }, () =>
      executeCommand({ commandId: cmdId, args: [], agentId: AGENT }),
    ),
  );

  const after = (db.prepare('SELECT COUNT(*) as c FROM execution_receipts').get() as { c: number }).c;
  assert(after - before === N, `expected ${N} new receipts, got ${after - before}`);
});

// ─── MCP server status ────────────────────────────────────────────────────────

test('MCP: unknown server ID returns status "unknown"', async () => {
  const status = getMcpServerStatus('nonexistent-mcp-' + randomUUID());
  assert(status === 'unknown', `expected 'unknown', got '${status}'`);
});

// ─── Validator ───────────────────────────────────────────────────────────────

test('validateMotorCortex: valid for clean state', async () => {
  const report = validateMotorCortex();
  assert(typeof report.valid === 'boolean', 'valid must be boolean');
  assert(Array.isArray(report.errors),       'errors must be an array');
  if (!report.valid) throw new Error(`expected valid; errors: ${report.errors.join('; ')}`);
});

test('validateMotorCortex: detects invalid capability in grants', async () => {
  const db = rawDb() as DB;
  db.prepare(`
    INSERT INTO capability_grants (id, agent_id, capability, granted_at, granted_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), 'bad-agent', 'evil.hack', Date.now(), 'test');

  const report = validateMotorCortex();
  assert(!report.valid,                                 'must be invalid');
  assert(report.errors.some(e => e.includes('evil.hack')), 'error must name the bad capability');

  db.prepare(`DELETE FROM capability_grants WHERE capability='evil.hack'`).run();
});

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[test-motor-cortex] running tests...\n');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  [PASS] ${t.name}`);
      passed++;
    } catch (e: unknown) {
      console.error(`  [FAIL] ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  if (_sandbox) {
    try { fs.rmSync(_sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[test-motor-cortex] fatal:', e);
  process.exit(1);
});
