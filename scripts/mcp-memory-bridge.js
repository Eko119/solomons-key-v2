#!/usr/bin/env node
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { mkdirSync } = require('fs');
const { dirname, resolve } = require('path');

const DB_PATH = resolve('./data/solomons_key.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure base table exists (new schema uses content/metadata column names)
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id         TEXT PRIMARY KEY,
    namespace  TEXT,
    content    TEXT,
    embedding  BLOB,
    created_at INTEGER,
    metadata   TEXT
  )
`);

// Step 1: add embedding column if missing (handles legacy tables)
const existingCols = db.pragma('table_info(memories)').map(c => c.name);
if (!existingCols.includes('embedding')) {
  db.exec('ALTER TABLE memories ADD COLUMN embedding BLOB');
}

// ---------- Binary encoding ----------

const decodeEmbedding = (buffer) => {
  return new Float32Array(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    )
  );
};

const encodeEmbedding = (array) => {
  return Buffer.from(new Float32Array(array).buffer);
};

const calculateDotProduct = (a, b) => {
  let sum = 0;
  let i = 0;
  const len = a.length;
  while (i < len) {
    sum += a[i] * b[i];
    i++;
  }
  return sum;
};

// ---------- Concurrency lock ----------

let semantic_search_lock = false;

// ---------- Detect actual content column name (compat with legacy schema) ----------

const contentCol = existingCols.includes('content') ? 'content' :
                   existingCols.includes('value')   ? 'value'   : 'content';
const metaCol    = existingCols.includes('metadata')      ? 'metadata'      :
                   existingCols.includes('metadata_json')  ? 'metadata_json'  : 'metadata';
const keyColExists = existingCols.includes('key');

// ---------- Prepared statements ----------

const stmtFindByNsKey = keyColExists
  ? db.prepare('SELECT id FROM memories WHERE namespace = ? AND key = ?')
  : null;

const stmtInsert = db.prepare(
  keyColExists
    ? `INSERT INTO memories (id, namespace, key, ${contentCol}, ${metaCol}, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO memories (id, namespace, ${contentCol}, ${metaCol}, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)`
);

const stmtUpdateEmb = db.prepare(
  `UPDATE memories SET ${contentCol} = ?, ${metaCol} = ?, embedding = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
);
const stmtUpdateNoEmb = db.prepare(
  `UPDATE memories SET ${contentCol} = ?, ${metaCol} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
);

const stmtSearch = db.prepare(
  `SELECT id, namespace, ${keyColExists ? 'key,' : ''} ${contentCol}, ${metaCol}, created_at FROM memories ` +
  `WHERE namespace = ? AND (${keyColExists ? 'key LIKE ? OR ' : ''}${contentCol} LIKE ?) ORDER BY created_at DESC`
);

const stmtList = db.prepare(
  `SELECT id, namespace, ${keyColExists ? 'key,' : ''} ${contentCol}, ${metaCol}, created_at FROM memories ` +
  `WHERE namespace = ? ORDER BY created_at DESC`
);

const stmtSemanticScan = db.prepare(
  `SELECT id, ${contentCol} AS content, embedding, created_at, namespace FROM memories ` +
  `WHERE namespace = ? AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT 3000`
);

// ---------- Helpers ----------

function rowsToText(rows) {
  if (rows.length === 0) return 'No memories found.';
  return rows.map(r => {
    const key = r.key ? `  key:${r.key}` : '';
    const meta = r[metaCol] || r.metadata || null;
    return `id:${r.id}  ns:${r.namespace}${key}\ncontent:${r[contentCol] || r.content}\nmeta:${meta || 'null'}\ncreated:${r.created_at}`;
  }).join('\n---\n');
}

// ---------- Server ----------

const server = new McpServer({
  name: 'solomons-key-memory',
  version: '2.0.0',
});

// store_memory — updated to accept optional embedding
server.registerTool(
  'store_memory',
  {
    title: 'Store Memory',
    description: 'Store or update a keyed memory in a namespace. Optionally store a vector embedding.',
    inputSchema: {
      namespace:     z.string().min(1),
      key:           z.string().min(1),
      value:         z.string(),
      metadata_json: z.string().optional(),
      embedding:     z.array(z.number()).optional(),
    },
  },
  ({ namespace, key, value, metadata_json, embedding }) => {
    const embBlob = embedding ? encodeEmbedding(embedding) : null;
    const now = Date.now();

    if (stmtFindByNsKey) {
      const existing = stmtFindByNsKey.get(namespace, key);
      if (existing) {
        if (embBlob !== null) {
          stmtUpdateEmb.run(value, metadata_json ?? null, embBlob, existing.id);
        } else {
          stmtUpdateNoEmb.run(value, metadata_json ?? null, existing.id);
        }
        return { content: [{ type: 'text', text: `Updated memory id:${existing.id}` }] };
      }
      const id = randomUUID();
      stmtInsert.run(id, namespace, key, value, metadata_json ?? null, embBlob, now);
      return { content: [{ type: 'text', text: `Stored memory id:${id}` }] };
    }

    // No key column — insert without key
    const id = randomUUID();
    stmtInsert.run(id, namespace, value, metadata_json ?? null, embBlob, now);
    return { content: [{ type: 'text', text: `Stored memory id:${id}` }] };
  }
);

// search_memory — text LIKE search (unchanged behaviour)
server.registerTool(
  'search_memory',
  {
    title: 'Search Memory',
    description: 'Search memories in a namespace by key or content substring.',
    inputSchema: {
      namespace: z.string().min(1),
      query:     z.string().min(1),
    },
    annotations: { readOnlyHint: true },
  },
  ({ namespace, query }) => {
    const pattern = `%${query}%`;
    const args = keyColExists ? [namespace, pattern, pattern] : [namespace, pattern];
    const rows = stmtSearch.all(...args);
    return { content: [{ type: 'text', text: rowsToText(rows) }] };
  }
);

// list_memories — unchanged behaviour
server.registerTool(
  'list_memories',
  {
    title: 'List Memories',
    description: 'List all memories in a namespace.',
    inputSchema: {
      namespace: z.string().min(1),
    },
    annotations: { readOnlyHint: true },
  },
  ({ namespace }) => {
    const rows = stmtList.all(namespace);
    return { content: [{ type: 'text', text: rowsToText(rows) }] };
  }
);

// semantic_search — dot-product similarity over stored embeddings
server.registerTool(
  'semantic_search',
  {
    title: 'Semantic Search',
    description:
      'Search memories by vector similarity using dot-product scoring. ' +
      'Requires memories stored with an embedding.',
    inputSchema: {
      namespace:       z.string().min(1),
      query_embedding: z.array(z.number()),
      limit:           z.number().int().positive().optional(),
    },
    annotations: { readOnlyHint: true },
  },
  ({ namespace, query_embedding, limit }) => {
    // Step 5: concurrency lock
    if (semantic_search_lock) {
      return { content: [{ type: 'text', text: '[]' }] };
    }
    semantic_search_lock = true;

    try {
      // Step 4.1: scan candidates
      const rows = stmtSemanticScan.all(namespace);

      // Step 4.2: cap candidates
      const candidates = rows.slice(0, 1500);

      // Step 4.3: score
      const scored = candidates.map(row => {
        const vec = decodeEmbedding(row.embedding);
        const score = calculateDotProduct(query_embedding, vec);
        return { id: row.id, content: row.content, created_at: row.created_at, namespace: row.namespace, score };
      });

      // Step 4.4: sort — score DESC, created_at ASC on tie
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.created_at - b.created_at;
      });

      // Step 4.5: limit output
      const n = limit ?? 5;
      const top = scored.slice(0, n);

      // Step 4.6: embedding already excluded (not included in scored objects)
      const text = top.length === 0
        ? 'No results.'
        : top.map(r => `id:${r.id}  score:${r.score.toFixed(6)}  ns:${r.namespace}\ncontent:${r.content}\ncreated:${r.created_at}`).join('\n---\n');

      return { content: [{ type: 'text', text }] };
    } finally {
      semantic_search_lock = false;
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('solomons-key memory bridge running on stdio\n');
}

function shutdown() {
  try { db.close(); } catch { /* noop */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  process.stderr.write(`Fatal error running memory bridge: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
