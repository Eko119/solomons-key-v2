'use strict';
// Deterministic greedy-leader clustering for MCP Semantic Cortex v2.
// Pure Node.js, no external deps, no async, no input mutation, no randomness.

const CLUSTER_THRESHOLD = 0.82;
const EMBEDDING_DIM = 768;
const MAX_ITEMS = 1000;

// Step 1 — Similarity (dot product; equals cosine when vectors are unit-normalized)
const similarity = (a, b) => {
  let sum = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    sum += a[i] * b[i];
  }
  return sum;
};

// Step 4 — Centroid: mean of cluster vectors, then L2-normalized
const computeCentroid = (vectors) => {
  const centroid = new Float32Array(EMBEDDING_DIM);

  for (const vec of vectors) {
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      centroid[i] += vec[i];
    }
  }

  const len = vectors.length;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    centroid[i] /= len;
  }

  let mag = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    mag += centroid[i] * centroid[i];
  }
  mag = Math.sqrt(mag);

  if (mag !== 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      centroid[i] /= mag;
    }
  }

  return centroid;
};

// Main export
// Input:  Array<{ id: string, embedding: Float32Array(768), created_at: number }>
// Output: Array<{ memory_ids, centroid, created_at_min, created_at_max, size }>
const clusterMemories = (input) => {
  // Step 0 — Input validation
  if (!input || input.length === 0) return [];

  const items = input.length > MAX_ITEMS ? input.slice(0, MAX_ITEMS) : input;

  // Step 3 — Deterministic O(n²) greedy leader clustering
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;

    const seed = items[i];

    const cluster = {
      ids:            [seed.id],
      vectors:        [seed.embedding],
      created_at_min: seed.created_at,
      created_at_max: seed.created_at,
    };

    assigned.add(i);

    for (let j = i + 1; j < items.length; j++) {
      if (assigned.has(j)) continue;

      const candidate = items[j];
      const score = similarity(seed.embedding, candidate.embedding);

      if (score >= CLUSTER_THRESHOLD) {
        assigned.add(j);
        cluster.ids.push(candidate.id);
        cluster.vectors.push(candidate.embedding);

        if (candidate.created_at < cluster.created_at_min) {
          cluster.created_at_min = candidate.created_at;
        }
        if (candidate.created_at > cluster.created_at_max) {
          cluster.created_at_max = candidate.created_at;
        }
      }
    }

    clusters.push(cluster);
  }

  // Steps 5–6 — Build and return concept objects
  return clusters.map(cluster => ({
    memory_ids:     cluster.ids,
    centroid:       computeCentroid(cluster.vectors),
    created_at_min: cluster.created_at_min,
    created_at_max: cluster.created_at_max,
    size:           cluster.ids.length,
  }));
};

module.exports = { clusterMemories };
