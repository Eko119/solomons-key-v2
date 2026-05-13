import fs from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runAgent, AgentResult, classifyMessage } from './agent';
import { runSubprocessPool, PoolTask } from './agent-pool';
import { McpServerEntry } from './agent-create';
import { getAgent, listSpecialists, isValidAgentId, AgentResponse } from './agent-config';
import { retrieveContext, formatContext } from './memory';
import { ingestConversation } from './memory-ingest';
import { sanitizeOutput } from './exfiltration-guard';
import { insertAuditLog } from './db';
import { config } from './config';

// ---------- MCP Client Layer ----------

interface McpServerState {
  entry:     McpServerEntry;
  healthy:   boolean;
  toolCount: number;
}

const mcpServers: Map<string, McpServerState> = new Map();

export function getMcpStatus(): { name: string; healthy: boolean; toolCount: number }[] {
  return [...mcpServers.values()].map(s => ({ name: s.entry.name, healthy: s.healthy, toolCount: s.toolCount }));
}

export function getMcpConfigForAgent(agentId: string): McpServerEntry[] {
  const def = getAgent(agentId);
  if (!def.mcpServers.length) return [];
  return def.mcpServers
    .filter(name => mcpServers.has(name) && mcpServers.get(name)!.healthy)
    .map(name => mcpServers.get(name)!.entry);
}

export async function bootMcpServers(): Promise<void> {
  if (!config.mcpConfigPath) return;
  let entries: McpServerEntry[];
  try {
    const raw = fs.readFileSync(config.mcpConfigPath, 'utf-8');
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[mcp] failed to load config from ${config.mcpConfigPath}: ${msg}`);
    return;
  }

  for (const entry of entries) {
    const state: McpServerState = { entry, healthy: false, toolCount: 0 };
    mcpServers.set(entry.name, state);

    let transport;
    try {
      if (entry.transport === 'stdio' && entry.command) {
        transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: entry.env });
      } else if (entry.transport === 'http' && entry.url) {
        transport = new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers ?? {} } });
      } else {
        console.warn(`[mcp] ${entry.name}: invalid transport config — skipping`);
        continue;
      }

      const client = new Client({ name: 'solomons-key', version: '2.0' });
      const MCP_BOOT_TIMEOUT_MS = 10_000;
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP health check timed out (10s) — cold npx cache?')), MCP_BOOT_TIMEOUT_MS),
      );
      await Promise.race([client.connect(transport), timeout]);
      const tools = await Promise.race([client.listTools(), timeout]);
      state.healthy = true;
      state.toolCount = tools.tools.length;
      console.info(`[mcp] ${entry.name}: connected — ${state.toolCount} tools`);
      insertAuditLog(null, null, 'mcp_server_connected', `${entry.name} (${state.toolCount} tools)`);
      await client.close().catch(() => {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp] ${entry.name}: health check failed — ${msg}`);
      insertAuditLog(null, null, 'mcp_server_unhealthy', `${entry.name}: ${msg.slice(0, 200)}`);
    }
  }

  const total = mcpServers.size;
  const healthy = [...mcpServers.values()].filter(s => s.healthy).length;
  console.info(`[mcp] boot complete — ${healthy}/${total} servers healthy`);
}

// ---------- Envelope Logging ----------

function logEnvelope(agentId: string, env: AgentResponse): void {
  switch (env.type) {
    case 'error':
      console.warn(`[orch:${agentId}] agent error: ${env.payload}`);
      insertAuditLog(null, agentId, 'agent_error_envelope', env.payload.slice(0, 200));
      break;
    case 'done':
      console.debug(`[orch:${agentId}] done envelope received`);
      break;
    default:
      console.debug(`[orch:${agentId}] envelope type=${env.type}`);
      break;
  }
}

const MENTION_RE = /@(\w+)/g;

export interface DispatchOptions {
  chatId: number;
  text: string;
  sessionId?: string;
  fileAttachment?: {
    anthropicFileId: string;
    localPath:       string;
    fileName:        string;
    mimeType:        string;
  };
}

export interface DispatchOutcome {
  agentId: string;
  response: string;
  result?: AgentResult;
  fanOut?: { id: string; output: string }[];
}

export function extractMentions(text: string): string[] {
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const id = m[1].toLowerCase();
    if (isValidAgentId(id) && id !== 'main' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function buildSystemPrompt(agentId: string, chatId: number, text: string): Promise<string> {
  const def = getAgent(agentId);
  const ctx = await retrieveContext(text, agentId, chatId);
  const memBlock = formatContext(ctx);
  return memBlock ? `${def.systemPrompt}\n\n--- MEMORY CONTEXT ---\n${memBlock}` : def.systemPrompt;
}

export async function dispatch(opts: DispatchOptions): Promise<DispatchOutcome> {
  const mentions = extractMentions(opts.text);

  if (mentions.length === 1) {
    return runSingle(mentions[0], opts);
  }

  if (mentions.length > 1) {
    return runFanOut(mentions, opts);
  }

  const cls = classifyMessage(opts.text);
  if (cls === 'simple') {
    return runSingle('main', opts);
  }

  return runSingle('main', opts);
}

async function runSingle(agentId: string, opts: DispatchOptions): Promise<DispatchOutcome> {
  const def = getAgent(agentId);
  const systemPrompt = await buildSystemPrompt(agentId, opts.chatId, opts.text);

  const mcpConfig = getMcpConfigForAgent(agentId);

  const result = await runAgent({
    agentId,
    chatId: opts.chatId,
    prompt: opts.text,
    systemPrompt,
    allowedTools: def.tools,
    mcpConfig: mcpConfig.length ? mcpConfig : undefined,
    model: def.model,
    sessionId: opts.sessionId,
    maxTurns: def.maxTurns,
    onEnvelope: (env) => logEnvelope(agentId, env),
    fileAttachment: opts.fileAttachment,
  });

  const sanitized = sanitizeOutput(result.response);
  if (sanitized !== result.response) {
    insertAuditLog(opts.chatId, agentId, 'exfil_redacted', `delta=${result.response.length - sanitized.length}`);
  }

  ingestConversation(opts.chatId, agentId, opts.text, sanitized);
  console.info(`[orch:${agentId}] payload ${sanitized.slice(0, 200)}`);
  return { agentId, response: sanitized, result };
}

async function runFanOut(agentIds: string[], opts: DispatchOptions): Promise<DispatchOutcome> {
  const tasks: PoolTask[] = [];
  for (const id of agentIds.slice(0, 5)) {
    const def = getAgent(id);
    const systemPrompt = await buildSystemPrompt(id, opts.chatId, opts.text);
    const agentMcp = getMcpConfigForAgent(id);
    tasks.push({
      id,
      prompt: opts.text,
      model: def.model,
      systemAppend: systemPrompt,
      allowedTools: def.tools,
      mcpConfig: agentMcp.length ? agentMcp : undefined,
      onEnvelope: (env) => logEnvelope(id, env),
    });
  }

  const results = await runSubprocessPool(tasks);
  const fanOut = results.map(r => {
    const sanitized = sanitizeOutput(r.output);
    if (sanitized !== r.output) {
      insertAuditLog(opts.chatId, r.id, 'exfil_redacted', `delta=${r.output.length - sanitized.length}`);
    }
    return { id: r.id, output: sanitized };
  });

  const combined = fanOut.map(r => `## @${r.id}\n${r.output}`).join('\n\n');
  for (const r of fanOut) ingestConversation(opts.chatId, r.id, opts.text, r.output);
  for (const r of fanOut) console.info(`[orch:${r.id}] payload ${r.output.slice(0, 200)}`);
  return { agentId: 'fan-out', response: combined, fanOut };
}

export function listAvailableSpecialists(): string {
  return listSpecialists().map(a => `@${a.id} — ${a.description}`).join('\n');
}
