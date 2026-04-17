import { runAgent, AgentResult, classifyMessage } from './agent';
import { runSubprocessPool, PoolTask } from './agent-pool';
import { getAgent, listSpecialists, isValidAgentId } from './agent-config';
import { retrieveContext, formatContext } from './memory';
import { ingestConversation } from './memory-ingest';
import { scanForSecrets } from './exfiltration-guard';
import { insertAuditLog } from './db';

const MENTION_RE = /@(\w+)/g;

export interface DispatchOptions {
  chatId: number;
  text: string;
  sessionId?: string;
}

export interface DispatchOutcome {
  agentId: string;
  response: string;
  result?: AgentResult;
  fanOut?: { id: string; output: string }[];
  blocked?: { reason: string };
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

  const result = await runAgent({
    agentId,
    chatId: opts.chatId,
    prompt: opts.text,
    systemPrompt,
    allowedTools: def.tools,
    model: def.model,
    sessionId: opts.sessionId,
    maxTurns: def.maxTurns,
  });

  const scan = scanForSecrets(result.response);
  if (scan.found) {
    insertAuditLog(opts.chatId, agentId, 'exfil_blocked', scan.matches.join(','));
    return {
      agentId,
      response: '[blocked — agent output contained potential secrets]',
      result,
      blocked: { reason: scan.matches.join(',') },
    };
  }

  ingestConversation(opts.chatId, agentId, opts.text, result.response);
  return { agentId, response: result.response, result };
}

async function runFanOut(agentIds: string[], opts: DispatchOptions): Promise<DispatchOutcome> {
  const tasks: PoolTask[] = [];
  for (const id of agentIds.slice(0, 5)) {
    const def = getAgent(id);
    const systemPrompt = await buildSystemPrompt(id, opts.chatId, opts.text);
    tasks.push({
      id,
      prompt: opts.text,
      model: def.model,
      systemAppend: systemPrompt,
      allowedTools: def.tools,
    });
  }

  const results = await runSubprocessPool(tasks);
  const fanOut = results.map(r => ({ id: r.id, output: r.output }));

  const combined = fanOut.map(r => `## @${r.id}\n${r.output}`).join('\n\n');
  const scan = scanForSecrets(combined);
  if (scan.found) {
    insertAuditLog(opts.chatId, 'fan-out', 'exfil_blocked', scan.matches.join(','));
    return {
      agentId: 'fan-out',
      response: '[blocked — fan-out output contained potential secrets]',
      fanOut,
      blocked: { reason: scan.matches.join(',') },
    };
  }

  for (const r of fanOut) ingestConversation(opts.chatId, r.id, opts.text, r.output);
  return { agentId: 'fan-out', response: combined, fanOut };
}

export function listAvailableSpecialists(): string {
  return listSpecialists().map(a => `@${a.id} — ${a.description}`).join('\n');
}
