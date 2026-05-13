import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config';
import {
  AgentRequest, AgentResponse,
  AgentRequestSchema, AgentResponseSchema,
} from './agent-config';

const DEFAULT_TIMEOUT_MS = 120_000;

export const CHECKPOINT_PROMPT = 'Summarize your progress so far in under 500 words, then stop.';

export interface McpServerEntry {
  name:      string;
  transport: 'stdio' | 'http';
  command?:  string;
  args?:     string[];
  url?:      string;
  headers?:  Record<string, string>;
  env?:      Record<string, string>;
}

export interface RunAgentOptions {
  agentId:       string;
  model?:        string;
  systemPrompt?: string;
  allowedTools?: string[];
  mcpConfig?:    McpServerEntry[];
  cwd?:          string;
  sessionId?:    string;
  timeoutMs?:    number;
  onEnvelope?:     (env: AgentResponse) => void;
  onStart?:        (pid: number | null) => void;
  fileAttachment?: {
    anthropicFileId: string;
    localPath:       string;
    fileName:        string;
    mimeType:        string;
  };
}

export interface AgentRunResult {
  envelopes:     AgentResponse[];
  finalResponse: string;
  sessionId:     string | null;
  inputTokens:   number;
  outputTokens:  number;
  costUsd:       number;
  model:         string;
  isError:       boolean;
  timedOut:      boolean;
}

export function createTaskRequest(payload: string, contextBudget = config.contextBudgetTokens): AgentRequest {
  return {
    id:            uuidv4(),
    type:          'task',
    payload,
    contextBudget,
    timestamp:     Date.now(),
  };
}

export function createCheckpointRequest(contextBudget = config.contextBudgetTokens): AgentRequest {
  return {
    id:            uuidv4(),
    type:          'checkpoint',
    payload:       CHECKPOINT_PROMPT,
    contextBudget,
    timestamp:     Date.now(),
  };
}

export function createShutdownRequest(): AgentRequest {
  return {
    id:            uuidv4(),
    type:          'shutdown',
    payload:       '',
    contextBudget: 0,
    timestamp:     Date.now(),
  };
}

function translateClaudeEvent(event: any, reqId: string): AgentResponse | null {
  if (!event || typeof event !== 'object') return null;

  if (event.type === 'assistant' && event.message?.content) {
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    const text = content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('');
    if (!text) return null;
    const out = event.message?.usage?.output_tokens;
    return {
      id:         reqId,
      type:       'result',
      payload:    text,
      tokenCount: typeof out === 'number' ? out : undefined,
      timestamp:  Date.now(),
    };
  }

  if (event.type === 'result') {
    const input = event.usage?.input_tokens ?? 0;
    const output = event.usage?.output_tokens ?? 0;
    return {
      id:         reqId,
      type:       'done',
      payload:    typeof event.result === 'string' ? event.result : '',
      tokenCount: input + output,
      timestamp:  Date.now(),
    };
  }

  return null;
}

export async function runAgentEnvelope(req: AgentRequest, opts: RunAgentOptions): Promise<AgentRunResult> {
  AgentRequestSchema.parse(req);

  const model = opts.model || (opts.agentId === 'main' ? config.mainModel : config.agentModel);
  const envelopes: AgentResponse[] = [];

  const emit = (env: AgentResponse): void => {
    const parsed = AgentResponseSchema.safeParse(env);
    if (!parsed.success) {
      console.warn(`[agent-create:${opts.agentId}] envelope schema mismatch: ${parsed.error.message}`);
      return;
    }
    envelopes.push(parsed.data);
    opts.onEnvelope?.(parsed.data);
  };

  if (req.type === 'shutdown') {
    emit({ id: req.id, type: 'done', payload: '', timestamp: Date.now() });
    return {
      envelopes, finalResponse: '', sessionId: null,
      inputTokens: 0, outputTokens: 0, costUsd: 0, model,
      isError: false, timedOut: false,
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--model', model,
  ];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.fileAttachment) {
    const relativePath = path
      .relative(config.projectRoot, opts.fileAttachment.localPath)
      .split(path.sep)
      .join(path.posix.sep);
    args.push(
      '--file',
      `${opts.fileAttachment.anthropicFileId}:${relativePath}`,
    );
  }
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.allowedTools?.length) args.push('--allowed-tools', opts.allowedTools.join(','));

  let mcpTmpFile: string | null = null;
  if (opts.mcpConfig?.length) {
    const mcpJson: Record<string, any> = {};
    for (const s of opts.mcpConfig) {
      if (s.transport === 'stdio' && s.command) {
        mcpJson[s.name] = { command: s.command, args: s.args ?? [], env: s.env ?? {} };
      } else if (s.transport === 'http' && s.url) {
        mcpJson[s.name] = { url: s.url, headers: s.headers ?? {} };
      }
    }
    mcpTmpFile = path.join(os.tmpdir(), `sk-mcp-${uuidv4()}.json`);
    fs.writeFileSync(mcpTmpFile, JSON.stringify({ mcpServers: mcpJson }));
    args.push('--mcp-config', mcpTmpFile, '--strict-mcp-config');
  }

  args.push('-p', req.payload);

  const cleanupMcpTmp = (): void => {
    if (mcpTmpFile) {
      try { fs.unlinkSync(mcpTmpFile); } catch { /* already gone */ }
      mcpTmpFile = null;
    }
  };

  return new Promise<AgentRunResult>(resolve => {
    const child = spawn('claude', args, {
      cwd: opts.cwd || config.projectRoot,
      env: { ...process.env, ANTHROPIC_API_KEY: config.anthropicApiKey },
    });
    opts.onStart?.(child.pid ?? null);

    let buffer = '';
    let stderrBuf = '';
    let finalized = false;
    let sessionId: string | null = opts.sessionId || null;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let isError = false;
    let timedOut = false;
    let finalResponse = '';
    let timer: NodeJS.Timeout;

    const fireTimeout = (): void => {
      if (finalized) return;
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    };

    const armTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fireTimeout, timeoutMs);
    };

    armTimer();

    const processLine = (raw: string): void => {
      const line = raw.trim();
      if (!line || !line.startsWith('{')) return;
      let nativeEvent: any;
      try {
        nativeEvent = JSON.parse(line);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[agent-create:${opts.agentId}] unparseable stdout line: ${msg}`);
        return;
      }

      if (nativeEvent?.type === 'result') {
        if (typeof nativeEvent.session_id === 'string') sessionId = nativeEvent.session_id;
        if (nativeEvent.usage) {
          inputTokens = nativeEvent.usage.input_tokens ?? 0;
          outputTokens = nativeEvent.usage.output_tokens ?? 0;
        }
        if (typeof nativeEvent.total_cost_usd === 'number') costUsd = nativeEvent.total_cost_usd;
        if (nativeEvent.is_error) isError = true;
        if (typeof nativeEvent.result === 'string') finalResponse = nativeEvent.result;
      }

      const env = translateClaudeEvent(nativeEvent, req.id);
      if (env) {
        emit(env);
        armTimer();
      }
    };

    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        processLine(line);
      }
    });

    child.stderr.on('data', (d: Buffer) => { stderrBuf += d.toString(); });

    child.on('close', (code) => {
      cleanupMcpTmp();
      if (finalized) return;
      finalized = true;
      if (timer) clearTimeout(timer);
      if (buffer.trim()) processLine(buffer);

      const hasDone = envelopes.some(e => e.type === 'done');
      if (!hasDone) {
        const failPayload = timedOut
          ? 'timeout'
          : `claude exited with code ${code}${stderrBuf ? `: ${stderrBuf.slice(0, 300)}` : ''}`;
        if (code !== 0 || timedOut) {
          isError = true;
          emit({ id: req.id, type: 'error', payload: failPayload, timestamp: Date.now() });
        }
        emit({ id: req.id, type: 'done', payload: finalResponse, timestamp: Date.now() });
      }

      if (!costUsd && (inputTokens || outputTokens)) {
        const isOpus = model.includes('opus');
        const inputRate = isOpus ? 15 : 3;
        const outputRate = isOpus ? 75 : 15;
        costUsd = ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000;
      }

      resolve({
        envelopes, finalResponse, sessionId,
        inputTokens, outputTokens, costUsd, model,
        isError, timedOut,
      });
    });

    child.on('error', (err) => {
      cleanupMcpTmp();
      if (finalized) return;
      finalized = true;
      if (timer) clearTimeout(timer);
      isError = true;
      emit({ id: req.id, type: 'error', payload: `spawn error: ${err.message}`, timestamp: Date.now() });
      emit({ id: req.id, type: 'done', payload: '', timestamp: Date.now() });
      resolve({
        envelopes, finalResponse: '', sessionId,
        inputTokens, outputTokens, costUsd, model,
        isError: true, timedOut: false,
      });
    });
  });
}
