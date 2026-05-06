'use strict';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDb } from './db';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS — single source of truth; no magic numbers elsewhere
// ─────────────────────────────────────────────────────────────────────────────

export const CENTROID_DIM                = 768;
export const MIN_SPLIT_SIZE              = 32;
export const SPLIT_VARIANCE_THRESHOLD    = 0.42;
export const SPLIT_COOLDOWN_MS           = 86_400_000;
export const FUSION_SIMILARITY_THRESHOLD = 0.985;
export const FUSION_COOLDOWN_MS          = 86_400_000;
export const MIN_CONCEPT_SIZE            = 4;

const POWER_ITER_MAX     = 500;
const POWER_ITER_EPSILON = 1e-10;
const SIGN_EPSILON       = 1e-9;

// ─────────────────────────────────────────────────────────────────────────────
// ERROR
// ─────────────────────────────────────────────────────────────────────────────

export class TopologyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TopologyError';
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ZOD SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

export const ConceptNodeSchema = z.object({
  id:           z.string().uuid(),
  agent_id:     z.string().min(1),
  created_at:   z.number().int().positive(),
  updated_at:   z.number().int().positive(),
  centroid:     z.array(z.number().finite()).length(CENTROID_DIM),
  variance:     z.number().finite().min(0),
  member_count: z.number().int().min(0),
});

export const ConceptLineageSchema = z.object({
  id:         z.string().uuid(),
  parent_id:  z.string().uuid().nullable(),
  event_type: z.enum(['root', 'split', 'fusion']),
  created_at: z.number().int().positive(),
});

export const ConceptMembershipSchema = z.object({
  memory_id:   z.string().min(1),
  concept_id:  z.string().uuid(),
  assigned_at: z.number().int().positive(),
});

export type ConceptNode       = z.infer<typeof ConceptNodeSchema>;
export type ConceptLineage    = z.infer<typeof ConceptLineageSchema>;
export type ConceptMembership = z.infer<typeof ConceptMembershipSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// BLOB ENCODING — Float64Array ↔ Buffer
// ─────────────────────────────────────────────────────────────────────────────

export function encodeCentroid(vec: number[]): Buffer {
  const f64 = new Float64Array(vec.length);
  for (let i = 0; i < vec.length; i++) f64[i] = vec[i];
  return Buffer.from(f64.buffer);
}

export function decodeCentroid(buf: Buffer): number[] {
  const f64 = new Float64Array(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  );
  return Array.from(f64);
}

// ─────────────────────────────────────────────────────────────────────────────
// DETERMINISTIC ID GENERATION
// ─────────────────────────────────────────────────────────────────────────────

function deterministicUUID(input: string): string {
  const h = createHash('sha256').update(input).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function splitChildId(parentId: string, side: 'L' | 'R', splitAt: number): string {
  return deterministicUUID(`${parentId}:${side}:${splitAt}`);
}

function lineageEventId(conceptId: string, eventType: string, eventAt: number): string {
  return deterministicUUID(`${conceptId}:${eventType}:${eventAt}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// VECTOR MATH — Float64Array throughout; never mutates inputs
// ─────────────────────────────────────────────────────────────────────────────

export function vecDot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function vecNorm(a: Float64Array): number {
  return Math.sqrt(vecDot(a, a));
}

export function vecCosineSimilarity(a: Float64Array, b: Float64Array): number {
  const nA = vecNorm(a);
  const nB = vecNorm(b);
  if (nA < SIGN_EPSILON || nB < SIGN_EPSILON) return 0;
  return vecDot(a, b) / (nA * nB);
}

function isFiniteF64(vec: Float64Array): boolean {
  for (let i = 0; i < vec.length; i++) {
    if (!isFinite(vec[i])) return false;
  }
  return true;
}

function toF64(arr: number[]): Float64Array {
  const f = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) f[i] = arr[i];
  return f;
}

// Decodes a JSON-encoded embedding string (format used by src/embeddings.ts).
// Returns null on any parse error, wrong dimension, or non-finite component.
function decodeMemoryEmbedding(jsonStr: string | null): Float64Array | null {
  if (!jsonStr) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(jsonStr); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== CENTROID_DIM) return null;
  const f = new Float64Array(CENTROID_DIM);
  for (let i = 0; i < CENTROID_DIM; i++) {
    const v = (parsed as unknown[])[i];
    if (typeof v !== 'number' || !isFinite(v)) return null;
    f[i] = v;
  }
  return f;
}

// ─────────────────────────────────────────────────────────────────────────────
// CENTROID AND VARIANCE
// ─────────────────────────────────────────────────────────────────────────────

function computeCentroid(vecs: Float64Array[]): Float64Array {
  const dim = vecs[0].length;
  const c = new Float64Array(dim);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) c[i] += v[i];
  }
  const n = vecs.length;
  for (let i = 0; i < dim; i++) c[i] /= n;
  return c;
}

export function computeVariance(vecs: Float64Array[], centroid: Float64Array): number {
  let sum = 0;
  for (const v of vecs) {
    let dist2 = 0;
    for (let i = 0; i < v.length; i++) {
      const d = v[i] - centroid[i];
      dist2 += d * d;
    }
    sum += dist2;
  }
  return sum / vecs.length;
}

// Pooled variance via parallel-axis theorem: O(D), no member re-scan.
// var_merged = (nA*(varA + ||cA-cM||²) + nB*(varB + ||cB-cM||²)) / (nA+nB)
function pooledVariance(
  nA: number, cA: Float64Array, varA: number,
  nB: number, cB: Float64Array, varB: number,
  cMerged: Float64Array,
): number {
  let distA2 = 0;
  let distB2 = 0;
  for (let i = 0; i < cA.length; i++) {
    const dA = cA[i] - cMerged[i];
    const dB = cB[i] - cMerged[i];
    distA2 += dA * dA;
    distB2 += dB * dB;
  }
  return (nA * (varA + distA2) + nB * (varB + distB2)) / (nA + nB);
}

// ─────────────────────────────────────────────────────────────────────────────
// PCA UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

// Sign canonicalization: scan left-to-right; first component where
// |v[i]| > SIGN_EPSILON must be positive. If negative, negate entire axis.
// Returns null when all components are near-zero (degenerate axis).
export function canonicalizeSign(axis: Float64Array): Float64Array | null {
  for (let i = 0; i < axis.length; i++) {
    if (Math.abs(axis[i]) > SIGN_EPSILON) {
      if (axis[i] > 0) return axis;
      const flipped = new Float64Array(axis.length);
      for (let j = 0; j < axis.length; j++) flipped[j] = -axis[j];
      return flipped;
    }
  }
  return null;
}

// Power iteration: dominant eigenvector of the sample covariance.
// Matrix-free: Cov × v = (1/N) × Xᵀ × (X × v), O(N×D) per iteration.
// Initial vector is always e_0 = [1, 0, ..., 0] — fully deterministic.
// Returns null if the covariance is degenerate (zero dominant eigenvalue).
export function dominantEigenvector(
  centered: Float64Array[],
  dim: number,
): Float64Array | null {
  const N = centered.length;
  let cur = new Float64Array(dim);
  cur[0] = 1.0;

  for (let iter = 0; iter < POWER_ITER_MAX; iter++) {
    const next = new Float64Array(dim);
    for (let k = 0; k < N; k++) {
      const s = vecDot(centered[k], cur);
      for (let j = 0; j < dim; j++) next[j] += s * centered[k][j];
    }
    for (let j = 0; j < dim; j++) next[j] /= N;

    const m = vecNorm(next);
    if (m < SIGN_EPSILON) return null;
    for (let j = 0; j < dim; j++) next[j] /= m;

    const dp = vecDot(cur, next);
    const converged = 1 - dp * dp < POWER_ITER_EPSILON;
    cur = next;
    if (converged) break;
  }

  return cur;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB ROW TYPES (internal — match actual SQLite column types)
// ─────────────────────────────────────────────────────────────────────────────

interface RawConceptRow {
  id:            string;
  agent_id:      string;
  created_at:    number;
  updated_at:    number;
  centroid:      Buffer;
  variance:      number;
  member_count:  number;
  last_split_at: number | null;
  last_fused_at: number | null;
  tombstoned:    number;
}

interface RawMemberRow {
  memory_id: string;
  embedding: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPLIT ENGINE
// ─────────────────────────────────────────────────────────────────────────────

// Returns true iff split was performed. Returns false if concept is ineligible
// or PCA is degenerate. Throws TopologyError on data invariant violation.
// All writes are atomic inside a single BEGIN IMMEDIATE transaction.
export function splitConcept(conceptId: string, now: number): boolean {
  const db = getDb();

  const tx = db.transaction((): boolean => {
    const concept = db.prepare<[string], RawConceptRow>(`
      SELECT id, agent_id, created_at, updated_at, centroid, variance,
             member_count, last_split_at, last_fused_at, tombstoned
      FROM concept_nodes WHERE id = ?
    `).get(conceptId);

    if (!concept || concept.tombstoned !== 0) return false;
    if (concept.member_count < MIN_SPLIT_SIZE) return false;
    if (concept.variance < SPLIT_VARIANCE_THRESHOLD) return false;
    if (concept.last_split_at !== null &&
        now - concept.last_split_at < SPLIT_COOLDOWN_MS) return false;

    const memberRows = db.prepare<[string], RawMemberRow>(`
      SELECT cm.memory_id, m.embedding
      FROM concept_membership cm
      JOIN memories m ON m.id = cm.memory_id
      WHERE cm.concept_id = ?
    `).all(conceptId);

    // Decode centroid
    const centroidArr = decodeCentroid(concept.centroid);
    if (centroidArr.length !== CENTROID_DIM) {
      throw new TopologyError('DIM_MISMATCH',
        `concept ${conceptId}: centroid dim=${centroidArr.length}`);
    }
    const centroidF64 = toF64(centroidArr);

    // Decode and validate member embeddings — skip invalid rows silently
    const pairs: Array<{ id: string; vec: Float64Array }> = [];
    for (const row of memberRows) {
      const vec = decodeMemoryEmbedding(row.embedding);
      if (!vec) continue;
      pairs.push({ id: row.memory_id, vec });
    }

    if (pairs.length < MIN_SPLIT_SIZE) return false;

    // Center vectors around concept centroid
    const centered: Float64Array[] = pairs.map(p => {
      const c = new Float64Array(CENTROID_DIM);
      for (let i = 0; i < CENTROID_DIM; i++) c[i] = p.vec[i] - centroidF64[i];
      return c;
    });

    // Power iteration → dominant eigenvector
    const rawAxis = dominantEigenvector(centered, CENTROID_DIM);
    if (!rawAxis) return false;

    // Sign canonicalization — abort on near-zero axis
    const axis = canonicalizeSign(rawAxis);
    if (!axis) return false;

    // Project, sort ascending by (projection, memory_id)
    const scored = pairs.map((p, i) => ({
      memory_id:  p.id,
      projection: vecDot(centered[i], axis),
    }));
    scored.sort((a, b) =>
      a.projection !== b.projection
        ? a.projection - b.projection
        : a.memory_id < b.memory_id ? -1 : a.memory_id > b.memory_id ? 1 : 0,
    );

    // Median partition
    const mid      = Math.floor(scored.length / 2);
    const leftIds  = scored.slice(0, mid).map(s => s.memory_id);
    const rightIds = scored.slice(mid).map(s => s.memory_id);

    if (leftIds.length < MIN_CONCEPT_SIZE || rightIds.length < MIN_CONCEPT_SIZE) return false;

    // Child centroids and variances
    const vecById   = new Map(pairs.map(p => [p.id, p.vec]));
    const leftVecs  = leftIds.map(id => vecById.get(id)!);
    const rightVecs = rightIds.map(id => vecById.get(id)!);

    const leftCentF64  = computeCentroid(leftVecs);
    const rightCentF64 = computeCentroid(rightVecs);
    const leftVar      = computeVariance(leftVecs,  leftCentF64);
    const rightVar     = computeVariance(rightVecs, rightCentF64);

    // Deterministic child IDs
    const leftId  = splitChildId(conceptId, 'L', now);
    const rightId = splitChildId(conceptId, 'R', now);

    // ── Atomic writes ─────────────────────────────────────────────────────────

    const insertNode = db.prepare(`
      INSERT INTO concept_nodes
        (id, agent_id, created_at, updated_at, centroid, variance, member_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run(leftId,  concept.agent_id, now, now,
      encodeCentroid(Array.from(leftCentF64)),  leftVar,  leftIds.length);
    insertNode.run(rightId, concept.agent_id, now, now,
      encodeCentroid(Array.from(rightCentF64)), rightVar, rightIds.length);

    const insertLineage = db.prepare(`
      INSERT INTO concept_lineage (id, parent_id, event_type, created_at)
      VALUES (?, ?, 'split', ?)
    `);
    insertLineage.run(lineageEventId(leftId,  'split', now), conceptId, now);
    insertLineage.run(lineageEventId(rightId, 'split', now), conceptId, now);

    const reassign = db.prepare(`
      UPDATE concept_membership SET concept_id = ?, assigned_at = ? WHERE memory_id = ?
    `);
    for (const id of leftIds)  reassign.run(leftId,  now, id);
    for (const id of rightIds) reassign.run(rightId, now, id);

    // Update parent: record split time, zero out member_count
    db.prepare(`
      UPDATE concept_nodes
      SET last_split_at = ?, updated_at = ?, member_count = 0
      WHERE id = ?
    `).run(now, now, conceptId);

    return true;
  });

  return tx.immediate();
}

// ─────────────────────────────────────────────────────────────────────────────
// FUSION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

// Returns true iff fusion was performed. Returns false if ineligible.
// Winner = smallest created_at; lex-smaller id on tie.
// Loser is tombstoned; all loser memberships reassigned to winner.
export function fuseConcepts(idA: string, idB: string, now: number): boolean {
  const db = getDb();

  const tx = db.transaction((): boolean => {
    const loadConcept = db.prepare<[string], RawConceptRow>(`
      SELECT id, agent_id, created_at, updated_at, centroid, variance,
             member_count, last_split_at, last_fused_at, tombstoned
      FROM concept_nodes WHERE id = ?
    `);
    const a = loadConcept.get(idA);
    const b = loadConcept.get(idB);

    if (!a || a.tombstoned !== 0) return false;
    if (!b || b.tombstoned !== 0) return false;
    if (a.agent_id !== b.agent_id) return false;

    // Decode centroids
    const cArr = decodeCentroid(a.centroid);
    const dArr = decodeCentroid(b.centroid);
    if (cArr.length !== CENTROID_DIM || dArr.length !== CENTROID_DIM) {
      throw new TopologyError('DIM_MISMATCH', 'centroid dimension mismatch');
    }
    const cAF64 = toF64(cArr);
    const cBF64 = toF64(dArr);

    if (!isFiniteF64(cAF64) || !isFiniteF64(cBF64)) {
      throw new TopologyError('NON_FINITE', 'non-finite centroid component');
    }

    // Similarity gate
    if (vecCosineSimilarity(cAF64, cBF64) < FUSION_SIMILARITY_THRESHOLD) return false;

    // Cooldown gate
    if (a.last_fused_at !== null && now - a.last_fused_at < FUSION_COOLDOWN_MS) return false;
    if (b.last_fused_at !== null && now - b.last_fused_at < FUSION_COOLDOWN_MS) return false;

    // Winner selection: oldest created_at; lex-smaller id on tie
    const aWins = a.created_at < b.created_at ||
      (a.created_at === b.created_at && a.id < b.id);
    const winner = aWins ? a : b;
    const loser  = aWins ? b : a;
    const wCF64  = aWins ? cAF64 : cBF64;
    const lCF64  = aWins ? cBF64 : cAF64;

    // Merged centroid (weighted mean)
    const nW = winner.member_count;
    const nL = loser.member_count;
    const nT = nW + nL;

    const merged = new Float64Array(CENTROID_DIM);
    if (nT > 0) {
      for (let i = 0; i < CENTROID_DIM; i++) {
        merged[i] = (nW * wCF64[i] + nL * lCF64[i]) / nT;
      }
    }

    const mergedVar = nT > 0
      ? pooledVariance(nW, wCF64, winner.variance, nL, lCF64, loser.variance, merged)
      : 0;

    // ── Atomic writes ─────────────────────────────────────────────────────────

    // Reassign all loser memberships to winner
    db.prepare(`
      UPDATE concept_membership SET concept_id = ?, assigned_at = ? WHERE concept_id = ?
    `).run(winner.id, now, loser.id);

    // Update winner stats
    db.prepare(`
      UPDATE concept_nodes
      SET centroid = ?, variance = ?, member_count = ?,
          updated_at = ?, last_fused_at = ?
      WHERE id = ?
    `).run(encodeCentroid(Array.from(merged)), mergedVar, nT, now, now, winner.id);

    // Tombstone loser
    db.prepare(`
      UPDATE concept_nodes SET tombstoned = 1, updated_at = ? WHERE id = ?
    `).run(now, loser.id);

    // Lineage: parent_id = loser (absorbed by winner)
    db.prepare(`
      INSERT INTO concept_lineage (id, parent_id, event_type, created_at) VALUES (?, ?, 'fusion', ?)
    `).run(lineageEventId(winner.id, 'fusion', now), loser.id, now);

    return true;
  });

  return tx.immediate();
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT CONCEPT CREATION
// ─────────────────────────────────────────────────────────────────────────────

export function createRootConcept(
  id: string,
  agentId: string,
  centroid: number[],
  variance: number,
  memberCount: number,
  now: number,
): void {
  const db = getDb();
  db.transaction((): void => {
    db.prepare(`
      INSERT INTO concept_nodes
        (id, agent_id, created_at, updated_at, centroid, variance, member_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, agentId, now, now, encodeCentroid(centroid), variance, memberCount);

    db.prepare(`
      INSERT INTO concept_lineage (id, parent_id, event_type, created_at) VALUES (?, NULL, 'root', ?)
    `).run(lineageEventId(id, 'root', now), now);
  }).immediate();
}

// ─────────────────────────────────────────────────────────────────────────────
// INVARIANT VALIDATOR
// ─────────────────────────────────────────────────────────────────────────────

export interface InvariantReport {
  valid:  boolean;
  errors: string[];
}

export function validateTopology(agentId: string): InvariantReport {
  const db    = getDb();
  const errors: string[] = [];

  const concepts = db.prepare<[string], RawConceptRow>(`
    SELECT id, variance, member_count, centroid, tombstoned
    FROM concept_nodes WHERE agent_id = ? AND tombstoned = 0
  `).all(agentId);

  for (const c of concepts) {
    if (!isFinite(c.variance) || c.variance < 0) {
      errors.push(`concept ${c.id}: invalid variance=${c.variance}`);
    }
    const vec = decodeCentroid(c.centroid);
    if (vec.length !== CENTROID_DIM) {
      errors.push(`concept ${c.id}: wrong centroid dim=${vec.length}`);
    } else if (!isFiniteF64(toF64(vec))) {
      errors.push(`concept ${c.id}: non-finite centroid component`);
    }
  }

  // Verify member_count matches actual membership rows
  const counts = db.prepare<[], { concept_id: string; cnt: number }>(`
    SELECT concept_id, COUNT(*) AS cnt FROM concept_membership GROUP BY concept_id
  `).all() as Array<{ concept_id: string; cnt: number }>;

  const countMap = new Map(counts.map(r => [r.concept_id, r.cnt]));
  for (const c of concepts) {
    const actual = countMap.get(c.id) ?? 0;
    if (actual !== c.member_count) {
      errors.push(
        `concept ${c.id}: member_count=${c.member_count} actual=${actual}`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
