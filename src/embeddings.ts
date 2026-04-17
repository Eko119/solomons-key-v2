import { GoogleGenAI } from '@google/genai';
import { config } from './config';

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: config.googleApiKey });
  return client;
}

export async function embed(text: string): Promise<number[] | null> {
  const trimmed = (text || '').trim().slice(0, 8000);
  if (!trimmed) return null;
  try {
    const res = await getClient().models.embedContent({
      model: config.geminiEmbedModel,
      contents: trimmed,
    });
    const values = res?.embeddings?.[0]?.values;
    if (!Array.isArray(values) || values.length === 0) return null;
    return values as number[];
  } catch (err: any) {
    console.error(`[embeddings] embed failed: ${err?.message || err}`);
    return null;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function encodeEmbedding(vec: number[]): string {
  return JSON.stringify(vec);
}

export function decodeEmbedding(str: string | null | undefined): number[] | null {
  if (!str) return null;
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
