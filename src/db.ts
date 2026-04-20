import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';

fs.mkdirSync(path.dirname(config.storePath), { recursive: true });

const db = new Database(config.storePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function runMigrations(database: Database.Database, migrationsDir: string): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    filename   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const files = fs.readdirSync(migrationsDir)
    .filter(f => /^\d{4}_.+\.sql$/.test(f) && !f.endsWith('.rollback.sql'))
    .sort();

  const check = database.prepare('SELECT 1 FROM schema_version WHERE version=?');
  const record = database.prepare(
    'INSERT INTO schema_version (version, filename, applied_at) VALUES (?, ?, ?)'
  );

  for (const file of files) {
    const version = parseInt(file.slice(0, 4), 10);
    if (check.get(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const tx = database.transaction(() => {
      database.exec(sql);
      record.run(version, file, Date.now());
    });

    try {
      tx();
      console.log(`[db] applied migration ${file}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`migration ${file} failed: ${msg}`);
    }
  }
}

runMigrations(db, path.join(config.projectRoot, 'src', 'migrations'));

export interface Memory {
  id: string;
  chat_id: string;
  agent_id: string;
  summary: string;
  raw_text?: string | null;
  entities?: string;
  topics?: string;
  importance: number;
  salience: number;
  pinned?: number;
  superseded_by?: string | null;
  consolidated?: number;
  embedding?: string | null;
  content_hash?: string | null;
  created_at: string;
  last_accessed?: string | null;
}

export interface MemoryRetryRow {
  id: number;
  chat_id: string;
  agent_id: string;
  content: string;
  content_hash: string;
  attempts: number;
  last_error: string | null;
  next_retry_at: number;
  created_at: number;
}

export interface TokenUsage {
  id: string;
  agent_id: string;
  chat_id: number | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  model: string;
  timestamp: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  cron_expr: string;
  agent_id: string;
  prompt: string;
  enabled?: number;
  last_run?: number | null;
  next_run?: number | null;
  created_at: number;
}

export interface MissionTask {
  id: string;
  title: string;
  prompt: string;
  agent_id?: string | null;
  priority?: number;
  status?: string;
  result?: string | null;
  created_at: number;
}

export interface MeetSession {
  id: string;
  agent_id?: string;
  meet_url: string;
  bot_name?: string | null;
  voice_id?: string | null;
  image_path?: string | null;
  brief_path?: string | null;
  status?: string;
  platform?: string | null;
  provider?: string;
  created_at: string;
}

export interface Consolidation {
  id: string;
  agent_id: string;
  insights: string;
  patterns?: string;
  contradictions?: string;
  memory_ids?: string;
  created_at: string;
}

// ---------- Sessions ----------
export function getSession(chatId: number, agentId: string) {
  return db.prepare('SELECT * FROM sessions WHERE chat_id=? AND agent_id=?').get(chatId, agentId) as any;
}

export function upsertSession(chatId: number, agentId: string, token?: string): void {
  const existing = getSession(chatId, agentId);
  if (existing) {
    db.prepare('UPDATE sessions SET last_activity=?, locked=0, token=COALESCE(?, token) WHERE chat_id=? AND agent_id=?')
      .run(Date.now(), token ?? null, chatId, agentId);
  } else {
    db.prepare('INSERT INTO sessions (id, chat_id, agent_id, last_activity, locked, token) VALUES (?, ?, ?, ?, 0, ?)')
      .run(uuidv4(), chatId, agentId, Date.now(), token ?? null);
  }
}

export function lockSession(chatId: number, agentId: string): void {
  db.prepare('UPDATE sessions SET locked=1 WHERE chat_id=? AND agent_id=?').run(chatId, agentId);
}

export function updateSessionActivity(chatId: number, agentId: string): void {
  db.prepare('UPDATE sessions SET last_activity=? WHERE chat_id=? AND agent_id=?').run(Date.now(), chatId, agentId);
}

export function isSessionLocked(chatId: number, agentId: string): boolean {
  const s = getSession(chatId, agentId);
  if (!s) return true;
  return !!s.locked;
}

export function lockAllSessions(): void {
  db.prepare('UPDATE sessions SET locked=1').run();
}

// ---------- Conversations ----------
export function saveConversationTurn(chatId: number, agentId: string, role: string, content: string, tokens = 0): void {
  db.prepare('INSERT INTO conversations (id, chat_id, agent_id, role, content, timestamp, tokens_used) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), chatId, agentId, role, content, Date.now(), tokens);
}

export function getRecentConversation(chatId: number, agentId: string, n = 20): any[] {
  return db.prepare('SELECT * FROM conversations WHERE chat_id=? AND agent_id=? ORDER BY timestamp DESC LIMIT ?')
    .all(chatId, agentId, n) as any[];
}

export function searchConversationHistory(keywords: string, agentId: string, dayWindow = 30, limit = 20): any[] {
  const since = Date.now() - dayWindow * 86400_000;
  const like = `%${keywords.replace(/[%_]/g, '')}%`;
  return db.prepare('SELECT * FROM conversations WHERE agent_id=? AND timestamp>=? AND content LIKE ? ORDER BY timestamp DESC LIMIT ?')
    .all(agentId, since, like, limit) as any[];
}

// ---------- Memories ----------
export function insertMemory(mem: Memory): void {
  db.prepare(`INSERT INTO memories (id, chat_id, agent_id, summary, raw_text, entities, topics, importance, salience, pinned, superseded_by, consolidated, embedding, content_hash, created_at, last_accessed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      mem.id, mem.chat_id, mem.agent_id, mem.summary, mem.raw_text ?? null,
      mem.entities ?? '[]', mem.topics ?? '[]', mem.importance, mem.salience,
      mem.pinned ?? 0, mem.superseded_by ?? null, mem.consolidated ?? 0,
      mem.embedding ?? null, mem.content_hash ?? null, mem.created_at, mem.last_accessed ?? null
    );
}

export function memoryExistsByHash(hash: string): boolean {
  return !!db.prepare('SELECT 1 FROM memories WHERE content_hash=? LIMIT 1').get(hash);
}

export function getMemoriesByAgent(agentId: string, limit = 500): any[] {
  return db.prepare('SELECT * FROM memories WHERE agent_id=? AND superseded_by IS NULL ORDER BY salience DESC, importance DESC LIMIT ?')
    .all(agentId, limit) as any[];
}

export function getUnconsolidatedMemories(agentId: string): any[] {
  return db.prepare('SELECT * FROM memories WHERE agent_id=? AND consolidated=0 AND superseded_by IS NULL').all(agentId) as any[];
}

export function markMemoriesConsolidated(ids: string[]): void {
  if (!ids.length) return;
  const stmt = db.prepare('UPDATE memories SET consolidated=1 WHERE id=?');
  const tx = db.transaction((batch: string[]) => { for (const id of batch) stmt.run(id); });
  tx(ids);
}

export function searchMemoriesFTS(query: string, limit = 20): any[] {
  try {
    return db.prepare(`SELECT m.* FROM memories m JOIN memories_fts f ON m.rowid=f.rowid
      WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`).all(query, limit) as any[];
  } catch {
    return [];
  }
}

export function getAllEmbeddings(agentId: string): { id: string; embedding: string | null }[] {
  return db.prepare('SELECT id, embedding FROM memories WHERE agent_id=? AND embedding IS NOT NULL AND superseded_by IS NULL')
    .all(agentId) as any[];
}

export function updateSalience(id: string, newValue: number): void {
  db.prepare('UPDATE memories SET salience=?, last_accessed=? WHERE id=?').run(newValue, new Date().toISOString(), id);
}

export function pinMemory(id: string): void {
  db.prepare('UPDATE memories SET pinned=1 WHERE id=?').run(id);
}

export function unpinMemory(id: string): void {
  db.prepare('UPDATE memories SET pinned=0 WHERE id=?').run(id);
}

export function setSupersededBy(oldId: string, newId: string): void {
  db.prepare('UPDATE memories SET superseded_by=? WHERE id=?').run(newId, oldId);
}

export function runSalienceDecay(factor = 0.995): void {
  db.prepare('UPDATE memories SET salience = salience * ? WHERE pinned=0 AND superseded_by IS NULL').run(factor);
}

export function getPinnedMemories(agentId: string): any[] {
  return db.prepare('SELECT * FROM memories WHERE agent_id=? AND pinned=1 AND superseded_by IS NULL ORDER BY created_at DESC').all(agentId) as any[];
}

// ---------- Memory Retry Queue ----------
export interface MemoryRetryEnqueue {
  chat_id:       string;
  agent_id:      string;
  content:       string;
  content_hash:  string;
  last_error:    string | null;
  next_retry_at: number;
}

export function enqueueMemoryRetry(entry: MemoryRetryEnqueue): void {
  db.prepare(`
    INSERT OR IGNORE INTO memory_retry_queue
      (chat_id, agent_id, content, content_hash, attempts, last_error, next_retry_at, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    entry.chat_id, entry.agent_id, entry.content, entry.content_hash,
    entry.last_error, entry.next_retry_at, Date.now(),
  );
}

export function getDueMemoryRetries(now: number, limit = 25): MemoryRetryRow[] {
  return db.prepare(
    'SELECT * FROM memory_retry_queue WHERE next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT ?'
  ).all(now, limit) as MemoryRetryRow[];
}

export function updateMemoryRetryAttempt(id: number, attempts: number, nextRetryAt: number, lastError: string | null): void {
  db.prepare(
    'UPDATE memory_retry_queue SET attempts=?, next_retry_at=?, last_error=? WHERE id=?'
  ).run(attempts, nextRetryAt, lastError, id);
}

export function deleteMemoryRetry(id: number): void {
  db.prepare('DELETE FROM memory_retry_queue WHERE id=?').run(id);
}

// ---------- Consolidations ----------
export function insertConsolidation(c: Consolidation): void {
  db.prepare('INSERT INTO consolidations (id, agent_id, insights, patterns, contradictions, memory_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(c.id, c.agent_id, c.insights, c.patterns ?? '[]', c.contradictions ?? '[]', c.memory_ids ?? '[]', c.created_at);
}

export function getLatestConsolidations(agentId: string, n = 5): any[] {
  return db.prepare('SELECT * FROM consolidations WHERE agent_id=? ORDER BY created_at DESC LIMIT ?').all(agentId, n) as any[];
}

// ---------- Hive Mind ----------
export function recordHiveActivity(agentId: string, action: string, summary?: string, artifacts?: string): void {
  db.prepare('INSERT INTO hive_mind (id, agent_id, action, summary, artifacts, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), agentId, action, summary ?? null, artifacts ?? null, Date.now());
}

export function getHiveActivity(agentId: string, limit = 50): any[] {
  return db.prepare('SELECT * FROM hive_mind WHERE agent_id=? ORDER BY timestamp DESC LIMIT ?').all(agentId, limit) as any[];
}

export function getAllAgentActivity(limit = 100): any[] {
  return db.prepare('SELECT * FROM hive_mind ORDER BY timestamp DESC LIMIT ?').all(limit) as any[];
}

// ---------- Audit ----------
export function insertAuditLog(chatId: number | null, agentId: string | null, action: string, detail?: string): void {
  db.prepare('INSERT INTO audit_log (id, chat_id, agent_id, action, detail, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), chatId, agentId, action, detail ?? null, Date.now());
}

export function getAuditLog(limit = 100): any[] {
  return db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?').all(limit) as any[];
}

// ---------- Scheduled Tasks ----------
export function insertScheduledTask(t: ScheduledTask): void {
  db.prepare('INSERT INTO scheduled_tasks (id, name, cron_expr, agent_id, prompt, enabled, last_run, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.id, t.name, t.cron_expr, t.agent_id, t.prompt, t.enabled ?? 1, t.last_run ?? null, t.next_run ?? null, t.created_at);
}

export function getEnabledScheduledTasks(): any[] {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE enabled=1 ORDER BY next_run ASC').all() as any[];
}

export function updateScheduledTaskRun(id: string, lastRun: number, nextRun: number): void {
  db.prepare('UPDATE scheduled_tasks SET last_run=?, next_run=? WHERE id=?').run(lastRun, nextRun, id);
}

export function setScheduledTaskEnabled(id: string, enabled: boolean): void {
  db.prepare('UPDATE scheduled_tasks SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
}

export function deleteScheduledTask(id: string): void {
  db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(id);
}

export function listScheduledTasks(): any[] {
  return db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as any[];
}

// ---------- Execution Log (scheduler) ----------
export function hasCompletedExecution(idempotencyKey: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM execution_log WHERE idempotency_key=? AND status='completed'"
  ).get(idempotencyKey);
}

export function startExecution(jobId: string, idempotencyKey: string): number {
  const row = db.prepare(`
    INSERT INTO execution_log (job_id, idempotency_key, started_at, status)
    VALUES (?, ?, ?, 'running')
    ON CONFLICT(idempotency_key) DO UPDATE SET
      started_at   = excluded.started_at,
      status       = 'running',
      completed_at = NULL,
      error        = NULL
    RETURNING id
  `).get(jobId, idempotencyKey, Date.now()) as { id: number };
  return row.id;
}

export function completeExecution(id: number): void {
  db.prepare("UPDATE execution_log SET status='completed', completed_at=? WHERE id=?")
    .run(Date.now(), id);
}

export function failExecution(id: number, errorMsg: string): void {
  db.prepare("UPDATE execution_log SET status='failed', completed_at=?, error=? WHERE id=?")
    .run(Date.now(), errorMsg, id);
}

// ---------- Mission Tasks ----------
export function insertMissionTask(t: MissionTask): void {
  db.prepare('INSERT INTO mission_tasks (id, title, prompt, agent_id, priority, status, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t.id, t.title, t.prompt, t.agent_id ?? null, t.priority ?? 0, t.status ?? 'queued', t.result ?? null, t.created_at);
}

export function getQueuedMissions(limit = 5): any[] {
  return db.prepare("SELECT * FROM mission_tasks WHERE status='queued' ORDER BY priority DESC, created_at ASC LIMIT ?").all(limit) as any[];
}

export function updateMissionStatus(id: string, status: string, result?: string): void {
  const now = Date.now();
  if (status === 'running') {
    db.prepare("UPDATE mission_tasks SET status=?, started_at=? WHERE id=?").run(status, now, id);
  } else if (status === 'completed' || status === 'failed') {
    db.prepare('UPDATE mission_tasks SET status=?, completed_at=?, result=COALESCE(?, result) WHERE id=?').run(status, now, result ?? null, id);
  } else {
    db.prepare('UPDATE mission_tasks SET status=?, result=COALESCE(?, result) WHERE id=?').run(status, result ?? null, id);
  }
}

export function getActiveMissions(): any[] {
  return db.prepare("SELECT * FROM mission_tasks WHERE status IN ('queued','running') ORDER BY priority DESC, created_at ASC").all() as any[];
}

export function getStuckMissions(timeoutMs: number): any[] {
  const cutoff = Date.now() - timeoutMs;
  return db.prepare("SELECT * FROM mission_tasks WHERE status='running' AND started_at < ? AND retry_count < 3").all(cutoff) as any[];
}

export function incrementMissionRetry(id: string): void {
  db.prepare("UPDATE mission_tasks SET retry_count = retry_count + 1, status='queued', started_at=NULL WHERE id=?").run(id);
}

export function listMissions(limit = 100): any[] {
  return db.prepare('SELECT * FROM mission_tasks ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
}

// ---------- Token Usage ----------
export function recordTokenUsage(u: TokenUsage): void {
  db.prepare('INSERT INTO token_usage (id, agent_id, chat_id, input_tokens, output_tokens, cost_usd, model, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(u.id, u.agent_id, u.chat_id, u.input_tokens, u.output_tokens, u.cost_usd, u.model, u.timestamp);
}

export function getTotalUsage(agentId?: string): { input_tokens: number; output_tokens: number; cost_usd: number } {
  const row = agentId
    ? db.prepare('SELECT COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cost_usd),0) cost_usd FROM token_usage WHERE agent_id=?').get(agentId)
    : db.prepare('SELECT COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(cost_usd),0) cost_usd FROM token_usage').get();
  return row as any;
}

export function getDailyCost(): number {
  const since = Date.now() - 86400_000;
  const row = db.prepare('SELECT COALESCE(SUM(cost_usd),0) cost_usd FROM token_usage WHERE timestamp>=?').get(since) as any;
  return row.cost_usd || 0;
}

// ---------- Meet Sessions ----------
export function insertMeetSession(s: MeetSession): void {
  db.prepare('INSERT INTO meet_sessions (id, agent_id, meet_url, bot_name, voice_id, image_path, brief_path, status, platform, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(s.id, s.agent_id ?? 'main', s.meet_url, s.bot_name ?? null, s.voice_id ?? null, s.image_path ?? null, s.brief_path ?? null, s.status ?? 'pending', s.platform ?? null, s.provider ?? 'pika', s.created_at);
}

export function updateMeetSessionStatus(id: string, status: string): void {
  const ended = (status === 'ended' || status === 'failed') ? new Date().toISOString() : null;
  db.prepare('UPDATE meet_sessions SET status=?, ended_at=COALESCE(?, ended_at) WHERE id=?').run(status, ended, id);
}

export function getActiveMeetSessions(): any[] {
  return db.prepare("SELECT * FROM meet_sessions WHERE status IN ('pending','active') ORDER BY created_at DESC").all() as any[];
}

export function getMeetSession(id: string): any {
  return db.prepare('SELECT * FROM meet_sessions WHERE id=?').get(id);
}

export function listMeetSessions(limit = 50): any[] {
  return db.prepare('SELECT * FROM meet_sessions ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
}

export function rawDb(): any { return db; }
