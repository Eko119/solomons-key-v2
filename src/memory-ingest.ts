import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI } from '@google/genai';
import { config } from './config';
import {
  insertMemory, getAllEmbeddings, updateSalience, insertAuditLog,
  Memory,
} from './db';
import { embed, cosineSimilarity, encodeEmbedding, decodeEmbedding } from './embeddings';

const DUP_THRESHOLD = 0.85;
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

export function ingestConversation(chatId: number, agentId: string, userMsg: string, assistantResp: string): void {
  void ingestAsync(chatId, agentId, userMsg, assistantResp).catch(err => {
    console.error(`[memory-ingest] ingestion failed: ${err?.message || err}`);
  });
}

async function ingestAsync(chatId: number, agentId: string, userMsg: string, assistantResp: string): Promise<void> {
  const turnText = `User: ${userMsg}\n\nAssistant: ${assistantResp}`;
  const extractPrompt = `${EXTRACT_SCHEMA_PROMPT}\n\n--- TURN ---\n${turnText}`;

  let extraction: Extraction | null = null;
  try {
    const res = await getClient().models.generateContent({
      model: config.geminiExtractModel,
      contents: extractPrompt,
    });
    const raw = (res as any)?.text || (res as any)?.response?.text || '';
    extraction = parseExtraction(typeof raw === 'function' ? raw() : raw);
  } catch (err: any) {
    console.error(`[memory-ingest] extraction call failed: ${err?.message || err}`);
    return;
  }

  if (!extraction || !extraction.summary || extraction.importance <= 0) return;

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
    created_at: new Date().toISOString(),
    last_accessed: null,
  };
  insertMemory(mem);

  if (extraction.importance >= 0.8) {
    insertAuditLog(chatId, agentId, 'memory_high_importance', extraction.summary.slice(0, 120));
  }
}

export function evaluateRelevance(memoryId: string, currentSalience: number, wasUsed: boolean): void {
  const delta = wasUsed ? 0.1 : -0.05;
  const next = Math.max(0, Math.min(1, currentSalience + delta));
  updateSalience(memoryId, next);
}
