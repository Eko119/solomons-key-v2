import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import { saveConversationTurn, recordHiveActivity, recordTokenUsage } from './db';

export interface QueryOptions {
  agentId: string;
  chatId: number;
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  allowedTools?: string[];
  model?: string;
  sessionId?: string;
  maxTurns?: number;
}

export interface AgentResult {
  response: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

interface ClaudeCliResult {
  result: string;
  session_id: string;
  total_cost_usd?: number;
  is_error?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

function extractResultJson(stdout: string): ClaudeCliResult | null {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && obj.type === 'result') return obj;
    } catch { /* skip */ }
  }
  return null;
}

export async function runAgent(opts: QueryOptions): Promise<AgentResult> {
  const model = opts.model || (opts.agentId === 'main' ? config.mainModel : config.agentModel);
  const args = [
    '--print',
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--model', model,
  ];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.allowedTools?.length) args.push('--allowed-tools', opts.allowedTools.join(','));
  args.push('-p', opts.prompt);

  const child = spawn('claude', args, {
    cwd: opts.cwd || config.projectRoot,
    env: { ...process.env, ANTHROPIC_API_KEY: config.anthropicApiKey },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

  const timeoutMs = config.agentTimeoutMs;
  const timeout = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* noop */ } }, timeoutMs);

  const exitCode: number | null = await new Promise(resolve => {
    child.on('close', code => resolve(code));
  });
  clearTimeout(timeout);

  const parsed = extractResultJson(stdout);
  if (!parsed) {
    throw new Error(`runAgent: claude CLI did not return parseable JSON. exit=${exitCode} stderr=${stderr.slice(0, 500)}`);
  }

  const inputTokens = parsed.usage?.input_tokens || 0;
  const outputTokens = parsed.usage?.output_tokens || 0;
  const finalResponse = parsed.result || '';
  const usedSessionId = parsed.session_id || opts.sessionId || uuidv4();

  const isOpus = model.includes('opus');
  const inputRate = isOpus ? 15 : 3;
  const outputRate = isOpus ? 75 : 15;
  const computedCost = ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000;
  const costUsd = parsed.total_cost_usd ?? computedCost;

  saveConversationTurn(opts.chatId, opts.agentId, 'user', opts.prompt, 0);
  saveConversationTurn(opts.chatId, opts.agentId, 'assistant', finalResponse, outputTokens);
  recordTokenUsage({
    id: uuidv4(), agent_id: opts.agentId, chat_id: opts.chatId,
    input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd,
    model, timestamp: Date.now(),
  });
  recordHiveActivity(opts.agentId, 'query', opts.prompt.slice(0, 120));

  if (parsed.is_error) {
    throw new Error(`runAgent: CLI reported error — ${finalResponse}`);
  }

  return { response: finalResponse, sessionId: usedSessionId, inputTokens, outputTokens, costUsd, model };
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
