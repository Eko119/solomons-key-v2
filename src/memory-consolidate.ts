import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI } from '@google/genai';
import { config } from './config';
import {
  getUnconsolidatedMemories, markMemoriesConsolidated,
  insertConsolidation, setSupersededBy, Consolidation,
} from './db';

const CONSOLIDATE_PROMPT = `You are a memory consolidator. Given the list of memories below, produce a JSON object:
{
  "insights": ["high-level insight 1", ...],
  "patterns": ["recurring pattern 1", ...],
  "contradictions": [{"older_id": "...", "newer_id": "...", "note": "..."}]
}
Rules:
- Insights should be non-trivial, not restatements of individual memories.
- Patterns capture repetition or habit across memories.
- Contradictions only if one memory clearly supersedes or negates another; otherwise [].
- Respond with ONLY the JSON, no prose, no markdown fences.`;

interface ConsolidationOutput {
  insights: string[];
  patterns: string[];
  contradictions: { older_id: string; newer_id: string; note: string }[];
}

const consolidationTimers: Map<string, NodeJS.Timeout> = new Map();
let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: config.googleApiKey });
  return client;
}

function parseConsolidation(text: string): ConsolidationOutput | null {
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*$/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1));
    return {
      insights: Array.isArray(obj.insights) ? obj.insights.map(String) : [],
      patterns: Array.isArray(obj.patterns) ? obj.patterns.map(String) : [],
      contradictions: Array.isArray(obj.contradictions) ? obj.contradictions.filter((c: any) =>
        c && typeof c.older_id === 'string' && typeof c.newer_id === 'string'
      ) : [],
    };
  } catch {
    return null;
  }
}

export async function consolidateMemories(agentId: string): Promise<void> {
  const pending = getUnconsolidatedMemories(agentId);
  if (pending.length < 5) return;

  const corpus = pending.slice(0, 50).map((m: any) =>
    `id=${m.id} | importance=${m.importance.toFixed(2)} | ${m.summary}`
  ).join('\n');

  let parsed: ConsolidationOutput | null = null;
  try {
    const res = await getClient().models.generateContent({
      model: config.geminiExtractModel,
      contents: `${CONSOLIDATE_PROMPT}\n\n--- MEMORIES ---\n${corpus}`,
    });
    const raw = (res as any)?.text || (res as any)?.response?.text || '';
    parsed = parseConsolidation(typeof raw === 'function' ? raw() : raw);
  } catch (err: any) {
    console.error(`[memory-consolidate] call failed for ${agentId}: ${err?.message || err}`);
    return;
  }
  if (!parsed) return;

  for (const c of parsed.contradictions) {
    try { setSupersededBy(c.older_id, c.newer_id); } catch { /* ignore bad ids */ }
  }

  const consolidation: Consolidation = {
    id: uuidv4(),
    agent_id: agentId,
    insights: JSON.stringify(parsed.insights),
    patterns: JSON.stringify(parsed.patterns),
    contradictions: JSON.stringify(parsed.contradictions),
    memory_ids: JSON.stringify(pending.map((m: any) => m.id)),
    created_at: new Date().toISOString(),
  };
  insertConsolidation(consolidation);
  markMemoriesConsolidated(pending.map((m: any) => m.id));
}

export function startConsolidationLoop(agentId: string, intervalMs = 30 * 60_000): void {
  stopConsolidationLoop(agentId);
  const t = setInterval(() => {
    void consolidateMemories(agentId).catch(err => {
      console.error(`[memory-consolidate] loop error for ${agentId}: ${err?.message || err}`);
    });
  }, intervalMs);
  consolidationTimers.set(agentId, t);
}

export function stopConsolidationLoop(agentId: string): void {
  const existing = consolidationTimers.get(agentId);
  if (existing) {
    clearInterval(existing);
    consolidationTimers.delete(agentId);
  }
}
