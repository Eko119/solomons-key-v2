'use strict';
// Dual-Layer Retrieval Dispatcher for MCP Semantic Cortex v2.
// Pure math, no async, no external deps, no randomness, fully deterministic.

// Step 0 — Similarity (dot product over 768 dims)
const dot = (a, b) => {
  let sum = 0;
  for (let i = 0; i < 768; i++) {
    sum += a[i] * b[i];
  }
  return sum;
};

// routeQuery — main dispatcher
// query_embedding : Float32Array(768)
// episodeResults  : Array<{ id, embedding: Float32Array, created_at }>  (K ≤ 150)
// conceptResults  : Array<{ id, centroid: Float32Array, weight: number }> (K ≤ 200)
// Returns: { route, episodicPeak, conceptPeak, episodicStd, conceptStd, peakRatio, distributionDelta }
const routeQuery = (query_embedding, episodeResults, conceptResults) => {
  // Step 1 — Episodic scoring
  const eN = episodeResults.length;
  let episodicPeak = 0;
  let episodicSum = 0;
  const eScores = new Array(eN);

  for (let i = 0; i < eN; i++) {
    const s = dot(query_embedding, episodeResults[i].embedding);
    eScores[i] = s;
    episodicSum += s;
    if (s > episodicPeak || i === 0) episodicPeak = s;
  }

  const episodicMean = eN > 0 ? episodicSum / eN : 0;
  let eVarSum = 0;
  for (let i = 0; i < eN; i++) {
    const d = eScores[i] - episodicMean;
    eVarSum += d * d;
  }
  const episodicVariance = eN > 0 ? eVarSum / eN : 0;
  const episodicStd = Math.sqrt(episodicVariance);

  // Step 2 — Concept scoring
  const cN = conceptResults.length;
  let conceptPeak = 0;
  let conceptSum = 0;
  const cScores = new Array(cN);

  for (let i = 0; i < cN; i++) {
    const s = dot(query_embedding, conceptResults[i].centroid) * conceptResults[i].weight;
    cScores[i] = s;
    conceptSum += s;
    if (s > conceptPeak || i === 0) conceptPeak = s;
  }

  const conceptMean = cN > 0 ? conceptSum / cN : 0;
  let cVarSum = 0;
  for (let i = 0; i < cN; i++) {
    const d = cScores[i] - conceptMean;
    cVarSum += d * d;
  }
  const conceptVariance = cN > 0 ? cVarSum / cN : 0;
  const conceptStd = Math.sqrt(conceptVariance);

  // Step 3 — Distribution gap metrics
  const peakRatio = episodicPeak / (conceptPeak + 1e-8);
  const distributionDelta = episodicStd - conceptStd;

  // Step 4 — Routing decision (strict rules, no fallback heuristics)
  let route;
  if (episodicPeak >= 0.85 && episodicStd >= conceptStd) {
    route = 'EPISODIC';
  } else if (conceptPeak >= 0.80 && conceptStd > episodicStd) {
    route = 'CONCEPT';
  } else {
    route = 'EPISODIC';
  }

  // Step 5 — Output (exact shape, no extra fields)
  return {
    route,
    episodicPeak,
    conceptPeak,
    episodicStd,
    conceptStd,
    peakRatio,
    distributionDelta,
  };
};

module.exports = { routeQuery };
