import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import { saveConversationTurn, recordHiveActivity, recordTokenUsage } from './db';
import { runAgentEnvelope, createTaskRequest, RunAgentOptions } from './agent-create';
import { AgentResponse } from './agent-config';
import {
  markAgentBusy, markAgentIdle, markAgentFaulted,
  setAgentPid, getAgentHealth,
} from './agent-pool';

export interface QueryOptions {
  agentId:       string;
  chatId:        number;
  prompt:        string;
  systemPrompt?: string;
  cwd?:          string;
  allowedTools?: string[];
  model?:        string;
  sessionId?:    string;
  maxTurns?:     number;
  onEnvelope?:   (env: AgentResponse) => void;
}

export interface AgentResult {
  response:     string;
  sessionId:    string;
  inputTokens:  number;
  outputTokens: number;
  costUsd:      number;
  model:        string;
}

export async function runAgent(opts: QueryOptions): Promise<AgentResult> {
  const health = getAgentHealth(opts.agentId);
  if (health && health.state === 'faulted') {
    throw new Error(`runAgent: agent ${opts.agentId} is faulted — skipping dispatch`);
  }

  markAgentBusy(opts.agentId, opts.prompt);

  const req = createTaskRequest(opts.prompt);

  const runOpts: RunAgentOptions = {
    agentId:      opts.agentId,
    model:        opts.model,
    systemPrompt: opts.systemPrompt,
    allowedTools: opts.allowedTools,
    cwd:          opts.cwd,
    sessionId:    opts.sessionId,
    timeoutMs:    config.agentTimeoutMs,
    onEnvelope:   opts.onEnvelope,
    onStart:      (pid) => setAgentPid(opts.agentId, pid),
  };

  const run = await runAgentEnvelope(req, runOpts);

  if (run.timedOut) {
    markAgentFaulted(opts.agentId, 'timeout');
    throw new Error(`runAgent: timed out after ${config.agentTimeoutMs}ms`);
  }
  if (run.isError && !run.finalResponse) {
    const errEnv = run.envelopes.find(e => e.type === 'error');
    const reason = errEnv?.payload || 'unknown error';
    markAgentFaulted(opts.agentId, reason);
    throw new Error(`runAgent: ${reason}`);
  }

  markAgentIdle(opts.agentId);

  const sessionId = run.sessionId || opts.sessionId || uuidv4();

  saveConversationTurn(opts.chatId, opts.agentId, 'user', opts.prompt, 0);
  saveConversationTurn(opts.chatId, opts.agentId, 'assistant', run.finalResponse, run.outputTokens);
  recordTokenUsage({
    id: uuidv4(), agent_id: opts.agentId, chat_id: opts.chatId,
    input_tokens: run.inputTokens, output_tokens: run.outputTokens,
    cost_usd: run.costUsd, model: run.model, timestamp: Date.now(),
  });
  recordHiveActivity(opts.agentId, 'query', opts.prompt.slice(0, 120));

  return {
    response:     run.finalResponse,
    sessionId,
    inputTokens:  run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd:      run.costUsd,
    model:        run.model,
  };
}

export function formatCostFooter(result: AgentResult, mode: string): string {
  const cost = `$${result.costUsd.toFixed(4)}`;
  const tokens = `${result.inputTokens}→${result.outputTokens}`;
  const shortModel = result.model.replace(/^claude-/, '').replace(/-20\d{6}$/, '');
  switch (mode) {
    case 'off':     return '';
    case 'cost':    return `\n\n[${cost}]`;
    case 'verbose': return `\n\n— ${shortModel} · ${tokens} tokens · ${cost}`;
    case 'full':    return `\n\n— ${shortModel} · ${tokens} tokens · ${cost} · session ${result.sessionId.slice(0, 8)}`;
    case 'compact':
    default:        return `\n\n[${shortModel} · ${cost}]`;
  }
}

const COMPLEX_RE = /\b(research|analyze|compare|investigate|plan|write|create|build|implement|schedule|remind|every|cron|draft|review|refactor|debug|fix|summarize|generate)\b/i;

export function classifyMessage(text: string): 'simple' | 'complex' {
  if (/@\w+/.test(text)) return 'complex';
  if (COMPLEX_RE.test(text)) return 'complex';
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words <= 6) return 'simple';
  if (text.length < 80) return 'simple';
  return 'complex';
}
