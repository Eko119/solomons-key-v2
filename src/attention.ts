'use strict';
import { z } from 'zod';
import { getDb } from './db';

// ---------- Constants ----------

export const DECAY_HALF_LIFE_HOURS = 72;           // t½ for temporal decay
export const REINFORCEMENT_COOLDOWN_MS = 3_600_000; // 1 hour minimum between reinforcements
export const MIN_WEIGHT = 0.01;                     // floor so score never reaches 0
export const MAX_WEIGHT = 10.0;                     // ceiling guards against overflow

// ---------- Zod schema ----------

export const MemoryNodeSchema = z.object({
  id:                  z.string().uuid(),
  agent_id:            z.string().min(1),
  salience:            z.number().finite().min(0).max(1),
  importance:          z.number().finite().min(0).max(1),
  reinforcement_count: z.number().int().min(1),
  last_reinforced_at:  z.number().int().positive(),
  created_at_epoch:    z.number().int().positive(),
});

export type MemoryNode = z.infer<typeof MemoryNodeSchema>;

// ---------- Internal math ----------

function decayFactor(ageMs: number): number {
  const ageHours = ageMs / 3_600_000;
  const halfLifeHours = DECAY_HALF_LIFE_HOURS;
  // Exponential decay: e^(-age * ln2 / t½)
  // Equivalent to (0.5)^(age/t½) but numerically cleaner
  const raw = Math.exp(-(ageHours * Math.LN2) / halfLifeHours);
  return Math.max(MIN_WEIGHT, raw);
}

function gainFactor(count: number): number {
  // log10(count + 10) grows slowly: count=1→1.079, count=100→2.041
  return Math.log10(count + 10);
}

// ---------- Public: scoring ----------

/**
 * Returns an attention weight in [MIN_WEIGHT, MAX_WEIGHT].
 * Combines temporal decay (how recently reinforced) with logarithmic gain
 * (how many times reinforced).
 *
 * @param node  Validated MemoryNode
 * @param now   Current epoch ms (caller-supplied for determinism/testing)
 */
export function getAttentionWeight(node: MemoryNode, now: number): number {
  const ageMs = Math.max(0, now - node.last_reinforced_at);
  const decay = decayFactor(ageMs);
  const gain  = gainFactor(node.reinforcement_count);
  const raw   = decay * gain;

  // Guard against NaN / Infinity from extreme inputs
  if (!isFinite(raw) || isNaN(raw)) return MIN_WEIGHT;

  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, raw));
}

/**
 * Multiplies a base similarity/relevance score by the attention weight.
 * Negative base scores are passed through unchanged — attention does not
 * flip sign (a very-forgettable memory should still rank below a more
 * relevant one, not jump above it).
 */
export function computeFinalScore(baseScore: number, weight: number): number {
  if (!isFinite(baseScore) || isNaN(baseScore)) return 0;
  if (baseScore < 0) return baseScore;
  const raw = baseScore * weight;
  if (!isFinite(raw) || isNaN(raw)) return 0;
  return raw;
}

// ---------- Public: reinforcement ----------

/**
 * Atomically increments reinforcement_count and updates last_reinforced_at.
 * The WHERE clause enforces the cooldown: if the last reinforcement was
 * within REINFORCEMENT_COOLDOWN_MS the UPDATE matches 0 rows → returns false.
 *
 * Returns true  iff exactly one row was updated.
 * Returns false if cooldown blocked the update or the id was not found.
 */
export function reinforceMemory(id: string, now: number): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE memories
    SET reinforcement_count  = reinforcement_count + 1,
        updated_at           = ?,
        last_reinforced_at   = ?
    WHERE id = ?
      AND last_reinforced_at IS NOT NULL
      AND (? - last_reinforced_at) >= ?
  `).run(now, now, id, now, REINFORCEMENT_COOLDOWN_MS);

  return result.changes === 1;
}
