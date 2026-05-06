#!/usr/bin/env node
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;

const server = new McpServer({
  name: 'solomons-key-fetch',
  version: '1.0.0',
});

server.registerTool(
  'fetch_url',
  {
    title: 'Fetch URL',
    description:
      'Fetch the body of an http(s) URL as UTF-8 text. ' +
      'Times out after 15s. Caps response body at 2 MB. ' +
      'Rejects non-http/https schemes.',
    inputSchema: { url: z.string().url() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url }) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Unsupported protocol: ${parsed.protocol} (only http/https allowed)`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'solomons-key-fetch/1.0' },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (!reader) {
        const text = await res.text();
        const truncated = Buffer.byteLength(text, 'utf8') > MAX_BYTES;
        const out = truncated ? Buffer.from(text, 'utf8').slice(0, MAX_BYTES).toString('utf8') : text;
        return { content: [{ type: 'text', text: out }] };
      }

      let total = 0;
      const chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          try { await reader.cancel(); } catch { /* noop */ }
          throw new Error(`Response body exceeded ${MAX_BYTES} bytes`);
        }
        chunks.push(Buffer.from(value));
      }

      const text = Buffer.concat(chunks).toString('utf8');
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        throw new Error(`Request timed out after ${TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('solomons-key fetch bridge running on stdio');
}

main().catch((err) => {
  console.error('Fatal error running fetch bridge:', err && err.message ? err.message : err);
  process.exit(1);
});
