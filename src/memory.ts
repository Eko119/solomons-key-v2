import {
  getPinnedMemories, getAllEmbeddings, searchMemoriesFTS, getLatestConsolidations,
  searchConversationHistory, rawDb, updateSalience,
} from './db';
import { embed, cosineSimilarity, decodeEmbedding } from './embeddings';

export interface MemoryContext {
  pinned: any[];
  semantic: any[];
  keyword: any[];
  consolidations: any[];
  conversation: any[];
}

const SEMANTIC_THRESHOLD = 0.6;
const SEMANTIC_TOP_K = 10;

function fetchMemoriesByIds(ids: string[]): any[] {
  if (!ids.length) return [];
  const db = rawDb();
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as any[];
}

export async function retrieveContext(query: string, agentId: string, chatId: number): Promise<MemoryContext> {
  const pinned = getPinnedMemories(agentId);

  let semantic: any[] = [];
  const queryVec = await embed(query);
  if (queryVec) {
    const rows = getAllEmbeddings(agentId);
    const scored: { id: string; score: number }[] = [];
    for (const row of rows) {
      const vec = decodeEmbedding(row.embedding);
      if (!vec) continue;
      const score = cosineSimilarity(queryVec, vec);
      if (score >= SEMANTIC_THRESHOLD) scored.push({ id: row.id, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const topIds = scored.slice(0, SEMANTIC_TOP_K).map(s => s.id);
    semantic = fetchMemoriesByIds(topIds);
    for (const id of topIds) {
      const match = semantic.find((m: any) => m.id === id);
      if (match) updateSalience(id, Math.min(1, match.salience + 0.05));
    }
  }

  const ftsQuery = query.replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8).join(' OR ');
  const keyword = ftsQuery ? searchMemoriesFTS(ftsQuery, 10) : [];

  const consolidations = getLatestConsolidations(agentId, 3);

  const conversation = searchConversationHistory(
    query.split(/\s+/).filter(Boolean).slice(0, 5).join(' '),
    agentId,
    chatId,
    30,
    10,
  );

  return { pinned, semantic, keyword, consolidations, conversation };
}

export function formatContext(ctx: MemoryContext): string {
  const parts: string[] = [];
  if (ctx.pinned.length) {
    parts.push('## Pinned\n' + ctx.pinned.map((m: any) => `- ${m.summary}`).join('\n'));
  }
  if (ctx.semantic.length) {
    parts.push('## Relevant memories\n' + ctx.semantic.map((m: any) => `- ${m.summary}`).join('\n'));
  }
  if (ctx.keyword.length) {
    const ids = new Set(ctx.semantic.map((m: any) => m.id));
    const extras = ctx.keyword.filter((m: any) => !ids.has(m.id));
    if (extras.length) parts.push('## Keyword matches\n' + extras.map((m: any) => `- ${m.summary}`).join('\n'));
  }
  if (ctx.consolidations.length) {
    const latest = ctx.consolidations[0];
    try {
      const insights = JSON.parse(latest.insights || '[]');
      if (insights.length) parts.push('## Latest insights\n' + insights.slice(0, 5).map((i: string) => `- ${i}`).join('\n'));
    } catch { /* ignore */ }
  }
  if (ctx.conversation.length) {
    parts.push('## Recent conversation\n' + ctx.conversation.slice(0, 5).map((c: any) => `- ${c.role}: ${String(c.content).slice(0, 200)}`).join('\n'));
  }
  return parts.join('\n\n');
}
