import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import { saveConversationTurn, recordHiveActivity, recordTokenUsage } from './db';
import {
  runAgentEnvelope, createTaskRequest, createCheckpointRequest, createShutdownRequest,
  RunAgentOptions,
} from './agent-create';
import { AgentResponse } from './agent-config';
import {
  markAgentBusy, markAgentIdle, markAgentFaulted,
  setAgentPid, getAgentHealth,
  noteAgentTokens, shouldCheckpoint, getAgentTokenTotal,
  setPendingCheckpointSummary, takePendingCheckpointSummary, resetTokenAccount,
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

  // AGENT-3: if a prior turn crossed the budget, it left a summary here.
  // Prepend it and start a fresh claude session so the new invocation begins
  // with the summary as its only context.
  const pending = takePendingCheckpointSummary(opts.chatId, opts.agentId);
  const effectivePrompt = pending
    ? `[Previous session summary — resume from this point]\n${pending}\n\n[Current task]\n${opts.prompt}`
    : opts.prompt;
  const effectiveSessionId = pending ? undefined : opts.sessionId;
  if (pending) {
    console.info(`[agent:${opts.agentId}] resumed from checkpoint summary (${pending.length} chars)`);
  }

  const req = createTaskRequest(effectivePrompt);

  const runOpts: RunAgentOptions = {
    agentId:      opts.agentId,
    model:        opts.model,
    systemPrompt: opts.systemPrompt,
    allowedTools: opts.allowedTools,
    cwd:          opts.cwd,
    sessionId:    effectiveSessionId,
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

  // AGENT-3: accumulate tokens and, if over 80% of budget, run checkpoint
  // + shutdown envelopes inline. The summary is stashed for the next turn
  // via setPendingCheckpointSummary; the current turn still returns its
  // own response unchanged.
  const budget = req.contextBudget;
  const total = noteAgentTokens(opts.chatId, opts.agentId, run.inputTokens + run.outputTokens);
  if (shouldCheckpoint(opts.chatId, opts.agentId, budget)) {
    console.info(`[agent:${opts.agentId}] context budget 80% threshold crossed (${total}/${budget}) — checkpointing`);
    await runCheckpoint(opts.agentId, opts.chatId, run.sessionId, runOpts);
  }

  const sessionId = run.sessionId || opts.sessionId || uuidv4();
  const finalText = run.envelopes.find(e => e.type === 'done')?.payload ?? run.finalResponse;

  saveConversationTurn(opts.chatId, opts.agentId, 'user', opts.prompt, 0);
  saveConversationTurn(opts.chatId, opts.agentId, 'assistant', finalText, run.outputTokens);
  recordTokenUsage({
    id: uuidv4(), agent_id: opts.agentId, chat_id: opts.chatId,
    input_tokens: run.inputTokens, output_tokens: run.outputTokens,
    cost_usd: run.costUsd, model: run.model, timestamp: Date.now(),
  });
  recordHiveActivity(opts.agentId, 'query', opts.prompt.slice(0, 120));

  return {
    response:     finalText,
    sessionId,
    inputTokens:  run.inputTokens,
    outputTokens: run.outputTokens,
    costUsd:      run.costUsd,
    model:        run.model,
  };
}

async function runCheckpoint(
  agentId: string,
  chatId: number,
  priorSessionId: string | null,
  baseOpts: RunAgentOptions,
): Promise<void> {
  try {
    const ckReq = createCheckpointRequest();
    const ckRun = await runAgentEnvelope(ckReq, {
      ...baseOpts,
      sessionId:  priorSessionId ?? undefined,
      onEnvelope: undefined,
    });

    if (ckRun.isError || !ckRun.finalResponse) {
      console.warn(`[agent:${agentId}] checkpoint produced no summary — next turn starts cold`);
      recordHiveActivity(agentId, 'checkpoint', '(no summary)');
    } else {
      const ckText = ckRun.envelopes.find(e => e.type === 'done')?.payload ?? ckRun.finalResponse;
      setPendingCheckpointSummary(chatId, agentId, ckText);
      recordHiveActivity(agentId, 'checkpoint', ckText.slice(0, 120));
      console.info(`[agent:${agentId}] checkpoint summary stashed (${ckText.length} chars, total tokens ${getAgentTokenTotal(chatId, agentId)})`);
    }

    const shutdownReq = createShutdownRequest();
    await runAgentEnvelope(shutdownReq, { ...baseOpts, onEnvelope: undefined });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[agent:${agentId}] checkpoint error: ${msg}`);
  } finally {
    resetTokenAccount(chatId, agentId);
  }
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
