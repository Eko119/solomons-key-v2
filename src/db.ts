import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';

fs.mkdirSync(path.dirname(config.storePath), { recursive: true });

const db = new Database(config.storePath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -64000');
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

export function lockAllSessions(): void {
  db.prepare('UPDATE sessions SET locked=1').run();
}

// ---------- Chat Sessions ----------
export function getSessionId(chatId: number): string | undefined {
  const row = db.prepare('SELECT session_id FROM chat_sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function upsertSessionId(chatId: number, sessionId: string): void {
  db.prepare(`
    INSERT INTO chat_sessions (chat_id, session_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(chatId, sessionId, Date.now());
}

// ---------- Conversations ----------
export function saveConversationTurn(chatId: number, agentId: string, role: string, content: string, tokens = 0): void {
  db.prepare('INSERT INTO conversations (id, chat_id, agent_id, role, content, timestamp, tokens_used) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uuidv4(), chatId, agentId, role, content, Date.now(), tokens);
}

export function searchConversationHistory(keywords: string, agentId: string, chatId: number, dayWindow = 30, limit = 20): any[] {
  const since = Date.now() - dayWindow * 86400_000;
  const like = `%${keywords.replace(/[%_]/g, '')}%`;
  return db.prepare('SELECT * FROM conversations WHERE agent_id=? AND chat_id=? AND timestamp>=? AND content LIKE ? ORDER BY timestamp DESC LIMIT ?')
    .all(agentId, chatId, since, like, limit) as any[];
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

export function setSupersededBy(oldId: string, newId: string): void {
  db.prepare('UPDATE memories SET superseded_by=? WHERE id=?').run(newId, oldId);
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

// ── Marketing helpers (MKTG-2) ──────────────────────────────────────────────

const TARGET_PLATFORMS = ['instagram', 'twitter', 'linkedin', 'tiktok'] as const;
type TargetPlatform = typeof TARGET_PLATFORMS[number];

const LEAD_STATUSES = ['unprocessed','enriched','queued','sent','replied','converted','disqualified'] as const;
type LeadStatus = typeof LEAD_STATUSES[number];

const OUTREACH_REPLY_OUTCOMES = ['replied','converted','bounced'] as const;
type OutreachReplyOutcome = typeof OUTREACH_REPLY_OUTCOMES[number];

export function createClient(params: {
  name: string;
  industry: string;
  targetPlatform: TargetPlatform;
  brandVoice: string;
}): string {
  if (!TARGET_PLATFORMS.includes(params.targetPlatform)) {
    throw new Error(`invalid targetPlatform: ${params.targetPlatform}`);
  }
  const id = uuidv4();
  const now = Date.now();
  db.prepare(
    'INSERT INTO clients (id, name, industry, target_platform, brand_voice, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, params.name, params.industry, params.targetPlatform, params.brandVoice, now, now);
  return id;
}

export function getClient(clientId: string): {
  id: string;
  name: string;
  industry: string;
  targetPlatform: string;
  brandVoice: string;
  createdAt: number;
  updatedAt: number;
} | null {
  const row = db.prepare('SELECT * FROM clients WHERE id=?').get(clientId) as
    { id: string; name: string; industry: string; target_platform: string; brand_voice: string; created_at: number; updated_at: number } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    targetPlatform: row.target_platform,
    brandVoice: row.brand_voice,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function upsertLead(params: {
  clientId: string;
  platform: string;
  profileUrl: string;
  displayName?: string;
  bio?: string;
  followerCount?: number;
  recentPosts?: string[];
}): { id: number; isNew: boolean } {
  const contentHash = crypto.createHash('sha256').update(params.profileUrl).digest('hex');
  const existing = db.prepare('SELECT id FROM leads WHERE content_hash=?').get(contentHash) as { id: number } | undefined;
  if (existing) return { id: existing.id, isNew: false };

  const info = db.prepare(
    `INSERT INTO leads (client_id, platform, profile_url, display_name, bio, follower_count, recent_posts, content_hash, status, scraped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unprocessed', ?)`
  ).run(
    params.clientId,
    params.platform,
    params.profileUrl,
    params.displayName ?? null,
    params.bio ?? null,
    params.followerCount ?? null,
    params.recentPosts ? JSON.stringify(params.recentPosts) : null,
    contentHash,
    Date.now(),
  );
  return { id: Number(info.lastInsertRowid), isNew: true };
}

export function updateLeadStatus(leadId: number, status: LeadStatus): void {
  if (!LEAD_STATUSES.includes(status)) {
    throw new Error(`invalid lead status: ${status}`);
  }
  db.prepare('UPDATE leads SET status=? WHERE id=?').run(status, leadId);
}

export function getLeadsByStatus(clientId: string, status: LeadStatus): {
  id: number;
  profileUrl: string;
  displayName: string | null;
  recentPosts: string[];
}[] {
  if (!LEAD_STATUSES.includes(status)) {
    throw new Error(`invalid lead status: ${status}`);
  }
  const rows = db.prepare(
    'SELECT id, profile_url, display_name, recent_posts FROM leads WHERE client_id=? AND status=? ORDER BY scraped_at DESC'
  ).all(clientId, status) as { id: number; profile_url: string; display_name: string | null; recent_posts: string | null }[];

  return rows.map(r => {
    let parsed: string[] = [];
    if (r.recent_posts) {
      try {
        const v = JSON.parse(r.recent_posts);
        if (Array.isArray(v) && v.every((x: unknown) => typeof x === 'string')) {
          parsed = v as string[];
        } else {
          console.warn(`[db] lead ${r.id} recent_posts not string[] — using []`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[db] lead ${r.id} recent_posts JSON parse failed: ${msg}`);
      }
    }
    return {
      id: r.id,
      profileUrl: r.profile_url,
      displayName: r.display_name,
      recentPosts: parsed,
    };
  });
}

export function createOutreachEvent(params: {
  clientId: string;
  leadId: number;
  draftText: string;
}): number {
  const info = db.prepare(
    'INSERT INTO outreach_events (client_id, lead_id, draft_text, queued_at) VALUES (?, ?, ?, ?)'
  ).run(params.clientId, params.leadId, params.draftText, Date.now());
  return Number(info.lastInsertRowid);
}

export function recordOutreachSent(eventId: number): void {
  db.prepare('UPDATE outreach_events SET sent_at=? WHERE id=?').run(Date.now(), eventId);
}

export function recordOutreachReply(params: {
  eventId: number;
  replyText: string;
  outcome: OutreachReplyOutcome;
}): void {
  if (!OUTREACH_REPLY_OUTCOMES.includes(params.outcome)) {
    throw new Error(`invalid outreach outcome: ${params.outcome}`);
  }
  db.prepare(
    'UPDATE outreach_events SET reply_received_at=?, reply_text=?, outcome=? WHERE id=?'
  ).run(Date.now(), params.replyText, params.outcome, params.eventId);
}

export function schedulePost(params: {
  clientId: string;
  platform: string;
  postText: string;
  scheduledFor: number;
}): number {
  const info = db.prepare(
    'INSERT INTO content_calendar (client_id, platform, post_text, scheduled_for) VALUES (?, ?, ?, ?)'
  ).run(params.clientId, params.platform, params.postText, params.scheduledFor);
  return Number(info.lastInsertRowid);
}

export function getScheduledPosts(clientId: string, fromTs: number, toTs: number): {
  id: number;
  platform: string;
  postText: string;
  scheduledFor: number;
}[] {
  const rows = db.prepare(
    "SELECT id, platform, post_text, scheduled_for FROM content_calendar WHERE client_id=? AND scheduled_for BETWEEN ? AND ? AND status='scheduled' ORDER BY scheduled_for ASC"
  ).all(clientId, fromTs, toTs) as { id: number; platform: string; post_text: string; scheduled_for: number }[];
  return rows.map(r => ({
    id: r.id,
    platform: r.platform,
    postText: r.post_text,
    scheduledFor: r.scheduled_for,
  }));
}

export function markPostPosted(postId: number): void {
  db.prepare("UPDATE content_calendar SET status='posted', posted_at=? WHERE id=?").run(Date.now(), postId);
}

export function markPostFailed(postId: number): void {
  db.prepare("UPDATE content_calendar SET status='failed' WHERE id=?").run(postId);
}

export function writeAnalyticsSnapshot(params: {
  clientId: string;
  periodStart: number;
  periodEnd: number;
  leadsScraped: number;
  dmsSent: number;
  repliesReceived: number;
  conversions: number;
  topPerformingHook?: string;
}): void {
  db.prepare(
    `INSERT INTO marketing_analytics
     (client_id, period_start, period_end, leads_scraped, dms_sent, replies_received, conversions, top_performing_hook, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.clientId,
    params.periodStart,
    params.periodEnd,
    params.leadsScraped,
    params.dmsSent,
    params.repliesReceived,
    params.conversions,
    params.topPerformingHook ?? null,
    Date.now(),
  );
}

export function getLatestAnalytics(clientId: string): {
  periodStart: number;
  periodEnd: number;
  leadsScraped: number;
  dmsSent: number;
  repliesReceived: number;
  conversions: number;
  topPerformingHook: string | null;
} | null {
  const row = db.prepare(
    'SELECT period_start, period_end, leads_scraped, dms_sent, replies_received, conversions, top_performing_hook FROM marketing_analytics WHERE client_id=? ORDER BY computed_at DESC LIMIT 1'
  ).get(clientId) as {
    period_start: number; period_end: number; leads_scraped: number; dms_sent: number;
    replies_received: number; conversions: number; top_performing_hook: string | null;
  } | undefined;
  if (!row) return null;
  return {
    periodStart: row.period_start,
    periodEnd: row.period_end,
    leadsScraped: row.leads_scraped,
    dmsSent: row.dms_sent,
    repliesReceived: row.replies_received,
    conversions: row.conversions,
    topPerformingHook: row.top_performing_hook,
  };
}

export function getLeadStatusCounts(clientId: string): Record<string, number> {
  const rows = db.prepare(
    'SELECT status, COUNT(*) as count FROM leads WHERE client_id=? GROUP BY status'
  ).all(clientId) as { status: string; count: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.count;
  return out;
}

export function getOutreachCounts(clientId: string): { sent: number; replied: number; converted: number } {
  const row = db.prepare(
    `SELECT
       SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent,
       SUM(CASE WHEN reply_received_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
       SUM(CASE WHEN outcome = 'converted' THEN 1 ELSE 0 END) AS converted
     FROM outreach_events
     WHERE client_id=?`
  ).get(clientId) as { sent: number | null; replied: number | null; converted: number | null };
  return {
    sent: row.sent ?? 0,
    replied: row.replied ?? 0,
    converted: row.converted ?? 0,
  };
}

// ── SolomonError + scrape_jobs helpers (P1-T2) ───────────────────────────────

export class SolomonError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SolomonError';
    this.code = code;
  }
}

const SCRAPE_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type ScrapeStatus = typeof SCRAPE_STATUSES[number];

export interface ScrapeJob {
  id: number;
  clientId: string;
  platform: string;
  searchTargets: string[];
  maxLeads: number;
  status: ScrapeStatus;
  startedAt: number | null;
  completedAt: number | null;
  leadsFound: number;
  error: string | null;
  createdAt: number;
}

export interface PendingScrapeJob {
  id: number;
  clientId: string;
  platform: string;
  searchTargets: string[];
  maxLeads: number;
}

export interface ScrapeJobSummary {
  id: number;
  platform: string;
  status: ScrapeStatus;
  leadsFound: number;
  createdAt: number;
}

export function createScrapeJob(params: {
  clientId: string;
  platform: string;
  searchTargets: string[];
  maxLeads?: number;
}): number {
  if (!Array.isArray(params.searchTargets)) {
    throw new SolomonError('searchTargets must be a string array', 'INVALID_SEARCH_TARGETS');
  }
  const day = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `${params.clientId}:${params.platform}:${day}`;
  try {
    const info = db.prepare(
      `INSERT INTO scrape_jobs (client_id, platform, search_targets, max_leads, created_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      params.clientId,
      params.platform,
      JSON.stringify(params.searchTargets),
      params.maxLeads ?? 50,
      Date.now(),
      idempotencyKey
    );
    return Number(info.lastInsertRowid);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE')) {
      throw new SolomonError(
        `duplicate scrape job for ${idempotencyKey}`,
        'DUPLICATE_SCRAPE_JOB'
      );
    }
    throw err;
  }
}

export function getScrapeJob(jobId: number): ScrapeJob | null {
  const row = db.prepare(
    `SELECT id, client_id, platform, search_targets, max_leads, status,
            started_at, completed_at, leads_found, error, created_at
     FROM scrape_jobs WHERE id=?`
  ).get(jobId) as {
    id: number;
    client_id: string;
    platform: string;
    search_targets: string;
    max_leads: number;
    status: ScrapeStatus;
    started_at: number | null;
    completed_at: number | null;
    leads_found: number;
    error: string | null;
    created_at: number;
  } | undefined;
  if (!row) return null;
  let searchTargets: string[];
  try {
    const parsed = JSON.parse(row.search_targets);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    searchTargets = parsed;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SolomonError(
      `scrape_job ${jobId} search_targets parse failed: ${msg}`,
      'INVALID_SEARCH_TARGETS'
    );
  }
  return {
    id: row.id,
    clientId: row.client_id,
    platform: row.platform,
    searchTargets,
    maxLeads: row.max_leads,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    leadsFound: row.leads_found,
    error: row.error,
    createdAt: row.created_at,
  };
}

export function listScrapeJobs(clientId: string): ScrapeJobSummary[] {
  const rows = db.prepare(
    `SELECT id, platform, status, leads_found, created_at
     FROM scrape_jobs WHERE client_id=? ORDER BY created_at DESC`
  ).all(clientId) as {
    id: number;
    platform: string;
    status: ScrapeStatus;
    leads_found: number;
    created_at: number;
  }[];
  return rows.map(r => ({
    id: r.id,
    platform: r.platform,
    status: r.status,
    leadsFound: r.leads_found,
    createdAt: r.created_at,
  }));
}

export function startScrapeJob(jobId: number): void {
  db.prepare('UPDATE scrape_jobs SET status=?, started_at=? WHERE id=?')
    .run('running', Date.now(), jobId);
}

export function completeScrapeJob(jobId: number, leadsFound: number): void {
  db.prepare('UPDATE scrape_jobs SET status=?, completed_at=?, leads_found=? WHERE id=?')
    .run('completed', Date.now(), leadsFound, jobId);
}

export function failScrapeJob(jobId: number, error: string): void {
  db.prepare('UPDATE scrape_jobs SET status=?, completed_at=?, error=? WHERE id=?')
    .run('failed', Date.now(), error, jobId);
}

export function getPendingScrapeJobs(): PendingScrapeJob[] {
  const rows = db.prepare(
    `SELECT id, client_id, platform, search_targets, max_leads
     FROM scrape_jobs WHERE status='pending' ORDER BY created_at ASC`
  ).all() as {
    id: number;
    client_id: string;
    platform: string;
    search_targets: string;
    max_leads: number;
  }[];
  return rows.map(r => {
    let searchTargets: string[] = [];
    try {
      const parsed = JSON.parse(r.search_targets);
      if (Array.isArray(parsed)) searchTargets = parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[db] scrape_job ${r.id} search_targets parse failed: ${msg}`);
    }
    return {
      id: r.id,
      clientId: r.client_id,
      platform: r.platform,
      searchTargets,
      maxLeads: r.max_leads,
    };
  });
}

// ── outreach_queue helpers + getEnrichedLeads (P2-T2) ────────────────────────

const OUTREACH_QUEUE_STATUSES = ['pending', 'approved', 'sent', 'rejected'] as const;
export type OutreachQueueStatus = typeof OUTREACH_QUEUE_STATUSES[number];

export interface OutreachQueueRow {
  id: number;
  clientId: string;
  leadId: number;
  draftMessage: string;
  status: OutreachQueueStatus;
  approvedAt: number | null;
  sentAt: number | null;
  rejectedAt: number | null;
  rejectionNote: string | null;
  createdAt: number;
}

export interface EnrichedLead {
  id: number;
  platform: string;
  profileUrl: string;
  displayName: string | null;
  bio: string | null;
  recentPosts: string[];
}

export function enqueueOutreach(params: {
  clientId: string;
  leadId: number;
  draftMessage: string;
}): number {
  const info = db.prepare(
    `INSERT INTO outreach_queue (client_id, lead_id, draft_message, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(params.clientId, params.leadId, params.draftMessage, Date.now());
  return Number(info.lastInsertRowid);
}

export function listOutreachQueue(
  clientId: string,
  status?: OutreachQueueStatus
): OutreachQueueRow[] {
  if (status !== undefined && !OUTREACH_QUEUE_STATUSES.includes(status)) {
    throw new SolomonError(`invalid outreach queue status: ${status}`, 'INVALID_OUTREACH_STATUS');
  }
  const rows = status
    ? db.prepare(
        `SELECT id, client_id, lead_id, draft_message, status, approved_at, sent_at,
                rejected_at, rejection_note, created_at
         FROM outreach_queue WHERE client_id=? AND status=? ORDER BY created_at DESC`
      ).all(clientId, status) as any[]
    : db.prepare(
        `SELECT id, client_id, lead_id, draft_message, status, approved_at, sent_at,
                rejected_at, rejection_note, created_at
         FROM outreach_queue WHERE client_id=? ORDER BY created_at DESC`
      ).all(clientId) as any[];
  return rows.map(r => ({
    id: r.id,
    clientId: r.client_id,
    leadId: r.lead_id,
    draftMessage: r.draft_message,
    status: r.status,
    approvedAt: r.approved_at,
    sentAt: r.sent_at,
    rejectedAt: r.rejected_at,
    rejectionNote: r.rejection_note,
    createdAt: r.created_at,
  }));
}

export function approveOutreach(queueId: number): void {
  db.prepare('UPDATE outreach_queue SET status=?, approved_at=? WHERE id=?')
    .run('approved', Date.now(), queueId);
}

export function rejectOutreach(queueId: number, note: string): void {
  db.prepare('UPDATE outreach_queue SET status=?, rejected_at=?, rejection_note=? WHERE id=?')
    .run('rejected', Date.now(), note, queueId);
}

export function markOutreachSent(queueId: number): void {
  db.prepare('UPDATE outreach_queue SET status=?, sent_at=? WHERE id=?')
    .run('sent', Date.now(), queueId);
}

export function getPendingOutreach(clientId: string): OutreachQueueRow[] {
  return listOutreachQueue(clientId, 'pending');
}

export function getEnrichedLeads(clientId: string): EnrichedLead[] {
  const rows = db.prepare(
    `SELECT id, platform, profile_url, display_name, bio, recent_posts
     FROM leads
     WHERE client_id=? AND status='enriched'
     ORDER BY enriched_at DESC, scraped_at DESC`
  ).all(clientId) as {
    id: number;
    platform: string;
    profile_url: string;
    display_name: string | null;
    bio: string | null;
    recent_posts: string | null;
  }[];
  return rows.map(r => {
    let recentPosts: string[] = [];
    if (r.recent_posts) {
      try {
        const parsed = JSON.parse(r.recent_posts);
        if (Array.isArray(parsed)) recentPosts = parsed;
      } catch {
        recentPosts = [];
      }
    }
    return {
      id: r.id,
      platform: r.platform,
      profileUrl: r.profile_url,
      displayName: r.display_name,
      bio: r.bio,
      recentPosts,
    };
  });
}
