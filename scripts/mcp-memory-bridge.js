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

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id            TEXT PRIMARY KEY,
    namespace     TEXT,
    key           TEXT,
    value         TEXT,
    metadata_json TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const stmtFindByNsKey = db.prepare(
  'SELECT id FROM memories WHERE namespace = ? AND key = ?'
);
const stmtInsert = db.prepare(
  'INSERT INTO memories (id, namespace, key, value, metadata_json) VALUES (?, ?, ?, ?, ?)'
);
const stmtUpdate = db.prepare(
  'UPDATE memories SET value = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
);
const stmtSearch = db.prepare(
  'SELECT id, namespace, key, value, metadata_json, created_at, updated_at ' +
  'FROM memories WHERE namespace = ? AND (key LIKE ? OR value LIKE ?) ORDER BY updated_at DESC'
);
const stmtList = db.prepare(
  'SELECT id, namespace, key, value, metadata_json, created_at, updated_at ' +
  'FROM memories WHERE namespace = ? ORDER BY updated_at DESC'
);

function rowsToText(rows) {
  if (rows.length === 0) return 'No memories found.';
  return rows.map(r =>
    `id:${r.id}  ns:${r.namespace}  key:${r.key}\nvalue:${r.value}\nmeta:${r.metadata_json || 'null'}\ncreated:${r.created_at}  updated:${r.updated_at}`
  ).join('\n---\n');
}

const server = new McpServer({
  name: 'solomons-key-memory',
  version: '1.0.0',
});

server.registerTool(
  'store_memory',
  {
    title: 'Store Memory',
    description: 'Store or update a keyed memory in a namespace.',
    inputSchema: {
      namespace:     z.string().min(1),
      key:           z.string().min(1),
      value:         z.string(),
      metadata_json: z.string().optional(),
    },
  },
  ({ namespace, key, value, metadata_json }) => {
    const existing = stmtFindByNsKey.get(namespace, key);
    if (existing) {
      stmtUpdate.run(value, metadata_json ?? null, existing.id);
      return { content: [{ type: 'text', text: `Updated memory id:${existing.id}` }] };
    }
    const id = randomUUID();
    stmtInsert.run(id, namespace, key, value, metadata_json ?? null);
    return { content: [{ type: 'text', text: `Stored memory id:${id}` }] };
  }
);

server.registerTool(
  'search_memory',
  {
    title: 'Search Memory',
    description: 'Search memories in a namespace by key or value substring.',
    inputSchema: {
      namespace: z.string().min(1),
      query:     z.string().min(1),
    },
    annotations: { readOnlyHint: true },
  },
  ({ namespace, query }) => {
    const pattern = `%${query}%`;
    const rows = stmtSearch.all(namespace, pattern, pattern);
    return { content: [{ type: 'text', text: rowsToText(rows) }] };
  }
);

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
