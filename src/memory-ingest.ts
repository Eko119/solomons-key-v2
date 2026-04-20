import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { config } from './config';
import {
  insertMemory, getAllEmbeddings, updateSalience, insertAuditLog,
  memoryExistsByHash, enqueueMemoryRetry, getDueMemoryRetries,
  updateMemoryRetryAttempt, deleteMemoryRetry,
  Memory, MemoryRetryRow,
} from './db';
import { embed, cosineSimilarity, encodeEmbedding, decodeEmbedding } from './embeddings';

const DUP_THRESHOLD = 0.85;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000];
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_POLL_INTERVAL_MS = 60_000;

const EXTRACT_SCHEMA_PROMPT = `Extract structured memory from the conversation turn below. Respond with ONLY a JSON object of this exact shape — no prose, no markdown fences:
{"summary": "1-2 sentence summary", "entities": ["person", "place", "project"], "topics": ["topic1"], "importance": 0.0, "raw_worth_saving": true}
- importance is 0.0–1.0; 0 means trivial chit-chat, 1 means critical fact/decision/commitment.
- raw_worth_saving: true iff the full text should be retained for later recall (commitments, numbers, names, quotes).
- If nothing notable happened, return {"summary":"","entities":[],"topics":[],"importance":0,"raw_worth_saving":false}.`;

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: config.googleApiKey });
  return client;
}

interface Extraction {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
  raw_worth_saving: boolean;
}

function parseExtraction(text: string): Extraction | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return {
      summary: String(obj.summary || '').trim(),
      entities: Array.isArray(obj.entities) ? obj.entities.map(String) : [],
      topics: Array.isArray(obj.topics) ? obj.topics.map(String) : [],
      importance: Math.max(0, Math.min(1, Number(obj.importance) || 0)),
      raw_worth_saving: Boolean(obj.raw_worth_saving),
    };
  } catch {
    return null;
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function runExtraction(content: string): Promise<Extraction | null> {
  const extractPrompt = `${EXTRACT_SCHEMA_PROMPT}\n\n--- TURN ---\n${content}`;
  const res = await getClient().models.generateContent({
    model: config.geminiExtractModel,
    contents: extractPrompt,
  });
  const raw = (res as any)?.text || (res as any)?.response?.text || '';
  return parseExtraction(typeof raw === 'function' ? raw() : raw);
}

export function ingestConversation(chatId: number, agentId: string, userMsg: string, assistantResp: string): void {
  void ingestAsync(chatId, agentId, userMsg, assistantResp).catch(err => {
    console.error(`[memory-ingest] ingestion failed: ${err?.message || err}`);
  });
}

async function ingestAsync(chatId: number, agentId: string, userMsg: string, assistantResp: string): Promise<void> {
  const turnText = `User: ${userMsg}\n\nAssistant: ${assistantResp}`;
  const contentHash = hashContent(turnText);

  if (memoryExistsByHash(contentHash)) {
    console.debug(`[memory-ingest] duplicate skipped (hash=${contentHash.slice(0, 8)})`);
    return;
  }

  let extraction: Extraction | null;
  try {
    extraction = await runExtraction(turnText);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[memory-ingest] extraction failed, enqueueing for retry: ${msg}`);
    enqueueMemoryRetry({
      chat_id:       String(chatId),
      agent_id:      agentId,
      content:       turnText,
      content_hash:  contentHash,
      last_error:    msg,
      next_retry_at: Date.now() + RETRY_DELAYS_MS[0],
    });
    return;
  }

  if (!extraction || !extraction.summary || extraction.importance <= 0) return;

  await persistMemory(chatId, agentId, turnText, contentHash, extraction);
}

async function persistMemory(
  chatId: number,
  agentId: string,
  turnText: string,
  contentHash: string,
  extraction: Extraction,
): Promise<void> {
  const vec = await embed(extraction.summary);
  if (vec) {
    const existing = getAllEmbeddings(agentId);
    for (const row of existing) {
      const other = decodeEmbedding(row.embedding);
      if (!other) continue;
      if (cosineSimilarity(vec, other) >= DUP_THRESHOLD) {
        const boosted = Math.min(1, 0.2 + extraction.importance * 0.3);
        updateSalience(row.id, boosted);
        return;
      }
    }
  }

  const mem: Memory = {
    id: uuidv4(),
    chat_id: String(chatId),
    agent_id: agentId,
    summary: extraction.summary,
    raw_text: extraction.raw_worth_saving ? turnText : null,
    entities: JSON.stringify(extraction.entities),
    topics: JSON.stringify(extraction.topics),
    importance: extraction.importance,
    salience: extraction.importance,
    pinned: 0,
    superseded_by: null,
    consolidated: 0,
    embedding: vec ? encodeEmbedding(vec) : null,
    content_hash: contentHash,
    created_at: new Date().toISOString(),
    last_accessed: null,
  };

  try {
    insertMemory(mem);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('UNIQUE')) {
      console.debug(`[memory-ingest] duplicate skipped at insert (hash=${contentHash.slice(0, 8)})`);
      return;
    }
    throw err;
  }

  if (extraction.importance >= 0.8) {
    insertAuditLog(chatId, agentId, 'memory_high_importance', extraction.summary.slice(0, 120));
  }
}

export function evaluateRelevance(memoryId: string, currentSalience: number, wasUsed: boolean): void {
  const delta = wasUsed ? 0.1 : -0.05;
  const next = Math.max(0, Math.min(1, currentSalience + delta));
  updateSalience(memoryId, next);
}

// ---------- Retry loop ----------

let retryTimer: NodeJS.Timeout | null = null;

export function startMemoryRetryLoop(): void {
  if (retryTimer) return;
  retryTimer = setInterval(() => { void processRetryQueue(); }, RETRY_POLL_INTERVAL_MS);
  void processRetryQueue();
}

export function stopMemoryRetryLoop(): void {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

async function processRetryQueue(): Promise<void> {
  let due: MemoryRetryRow[];
  try {
    due = getDueMemoryRetries(Date.now());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[memory-ingest] retry queue poll failed: ${msg}`);
    return;
  }
  for (const row of due) {
    await processOneRetry(row);
  }
}

async function processOneRetry(row: MemoryRetryRow): Promise<void> {
  let extraction: Extraction | null;
  try {
    extraction = await runExtraction(row.content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const nextAttempts = row.attempts + 1;
    if (nextAttempts >= MAX_RETRY_ATTEMPTS) {
      console.warn(`[memory-ingest] retry dropped after ${MAX_RETRY_ATTEMPTS} attempts (hash=${row.content_hash.slice(0, 8)}): ${msg}`);
      deleteMemoryRetry(row.id);
      return;
    }
    const delay = RETRY_DELAYS_MS[nextAttempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
    updateMemoryRetryAttempt(row.id, nextAttempts, Date.now() + delay, msg);
    console.warn(`[memory-ingest] retry ${nextAttempts}/${MAX_RETRY_ATTEMPTS} failed, next in ${Math.round(delay / 1000)}s: ${msg}`);
    return;
  }

  if (!extraction || !extraction.summary || extraction.importance <= 0) {
    deleteMemoryRetry(row.id);
    return;
  }

  const chatIdNum = parseInt(row.chat_id, 10);
  await persistMemory(
    isNaN(chatIdNum) ? 0 : chatIdNum,
    row.agent_id,
    row.content,
    row.content_hash,
    extraction,
  );
  deleteMemoryRetry(row.id);
}
