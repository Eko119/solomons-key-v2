'use strict';
// Async ingestion worker — Ollama embedding pipeline for MCP semantic cortex.
// Writes to ./data/solomons_key.db alongside mcp-memory-bridge.js.
// export const ingestMemory is the single public entry point.

const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { mkdirSync } = require('fs');
const { resolve, dirname } = require('path');

// ---------- DB (lazy init, shared within this module) ----------

const DB_PATH = resolve('./data/solomons_key.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

let _db = null;
let _contentCol = 'value';
let _metaCol = 'metadata_json';

function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      namespace     TEXT,
      content       TEXT,
      embedding     BLOB,
      created_at    INTEGER,
      metadata      TEXT
    )
  `);

  const cols = _db.pragma('table_info(memories)').map(c => c.name);

  if (!cols.includes('embedding')) {
    _db.exec('ALTER TABLE memories ADD COLUMN embedding BLOB');
  }

  // Detect actual column names (compat with legacy schema)
  _contentCol = cols.includes('content') ? 'content'
              : cols.includes('value')   ? 'value'
              : 'content';
  _metaCol    = cols.includes('metadata')      ? 'metadata'
              : cols.includes('metadata_json')  ? 'metadata_json'
              : 'metadata';

  return _db;
}

// ---------- Binary encoding ----------

const encodeEmbedding = (array) => {
  return Buffer.from(new Float32Array(array).buffer);
};

// ---------- Queue state ----------

const INGEST_QUEUE = [];
const MAX_QUEUE_SIZE = 500;
let isProcessing = false;

// ---------- Delay utility ----------

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ---------- Vector normalization ----------

const normalizeVector = (vec) => {
  let magnitude = 0;
  for (let i = 0; i < vec.length; i++) {
    magnitude += vec[i] * vec[i];
  }
  magnitude = Math.sqrt(magnitude);
  if (magnitude === 0) return vec;
  for (let i = 0; i < vec.length; i++) {
    vec[i] = vec[i] / magnitude;
  }
  return vec;
};

// ---------- Ollama embedding client ----------

const fetchEmbedding = async (text) => {
  const payload = {
    model: 'nomic-embed-text',
    prompt: text,
  };

  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch('http://localhost:11434/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) throw new Error('OLLAMA_HTTP_ERROR');

      const data = await res.json();

      if (!data.embedding) throw new Error('INVALID_EMBEDDING');

      return data.embedding;

    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      await delay(50 * (attempt + 1));
    }
  }
};

// ---------- SQLite write ----------

const store_memory = async ({ namespace, content, embedding, metadata }) => {
  const db = getDb();
  const id = randomUUID();
  const embBlob = embedding ? encodeEmbedding(embedding) : null;
  const now = Date.now();
  const metaVal = metadata
    ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata))
    : null;

  db.prepare(
    `INSERT INTO memories (id, namespace, ${_contentCol}, embedding, ${_metaCol}, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, namespace ?? 'default', content, embBlob, metaVal, now);

  return id;
};

// ---------- Ingestion pipeline ----------

const handleIngestion = async (item) => {
  const text = item.text;
  const namespace = item.namespace;
  const metadata = item.metadata;

  const embedding = await fetchEmbedding(text);

  const normalized = normalizeVector(embedding);

  await store_memory({
    namespace: namespace,
    content: text,
    embedding: normalized,
    metadata: metadata,
  });
};

// ---------- Single-writer loop ----------

const processQueue = async () => {
  if (isProcessing === true) return;

  isProcessing = true;

  while (INGEST_QUEUE.length > 0) {
    const item = INGEST_QUEUE.shift();

    try {
      await handleIngestion(item);
    } catch (err) {
      console.error('INGEST_ERROR', err);
    }
  }

  isProcessing = false;
};

// ---------- Public API ----------

const ingestMemory = (payload) => {
  if (!payload || !payload.text) return;

  if (INGEST_QUEUE.length >= MAX_QUEUE_SIZE) {
    INGEST_QUEUE.shift();
  }

  INGEST_QUEUE.push(payload);

  if (isProcessing === false) {
    processQueue();
  }
};

module.exports = { ingestMemory };
