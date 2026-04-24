import { runAgentEnvelope, createTaskRequest } from './agent-create';
import { AgentResponse, AGENT_IDS } from './agent-config';

export interface PoolTask {
  id:            string;
  prompt:        string;
  model?:        string;
  cwd?:          string;
  systemAppend?: string;
  allowedTools?: string[];
  onEnvelope?:   (env: AgentResponse) => void;
}

export interface PoolResult {
  id:          string;
  output:      string;
  exitCode:    number | null;
  durationMs:  number;
  sentinelSeen: boolean;
  timedOut:    boolean;
}

// ---------- Agent Health State Machine (AGENT-2) ----------

export type AgentState = 'idle' | 'busy' | 'faulted' | 'restarting';

export interface AgentHealth {
  agentId:         string;
  state:           AgentState;
  lastTask:        string | null;
  lastError:       string | null;
  restartAttempts: number;
  lastTransition:  number;
  pid:             number | null;
}

const RESTART_DELAY_MS = 5_000;
const MAX_RESTART_ATTEMPTS = 3;
const STAGGER_MS = 3_000;
const MAX_CONCURRENT = 5;

// ---------- AGENT-3: per-session token accounting + checkpoint hand-off ----------
// A session is uniquely identified by (chatId, agentId). Tokens accumulate
// across that session's turns; once the running total crosses 80% of the
// request's contextBudget, the caller runs a checkpoint and stashes the
// resulting summary here. The next turn consumes the summary, prepends it to
// its payload, and starts a fresh claude invocation — effectively the
// "spawn a new process" behavior from the v2 spec.
interface TokenAccount {
  total:          number;
  pendingSummary: string | null;
}

const tokenAccounts = new Map<string, TokenAccount>();

function accountKey(chatId: number, agentId: string): string {
  return `${chatId}:${agentId}`;
}

function getOrCreateAccount(chatId: number, agentId: string): TokenAccount {
  const k = accountKey(chatId, agentId);
  let acc = tokenAccounts.get(k);
  if (!acc) {
    acc = { total: 0, pendingSummary: null };
    tokenAccounts.set(k, acc);
  }
  return acc;
}

export function noteAgentTokens(chatId: number, agentId: string, tokens: number): number {
  const acc = getOrCreateAccount(chatId, agentId);
  acc.total += Math.max(0, tokens);
  return acc.total;
}

export function getAgentTokenTotal(chatId: number, agentId: string): number {
  return tokenAccounts.get(accountKey(chatId, agentId))?.total ?? 0;
}

export function shouldCheckpoint(chatId: number, agentId: string, budget: number): boolean {
  if (budget <= 0) return false;
  return getAgentTokenTotal(chatId, agentId) > 0.8 * budget;
}

export function setPendingCheckpointSummary(chatId: number, agentId: string, summary: string): void {
  getOrCreateAccount(chatId, agentId).pendingSummary = summary;
}

export function takePendingCheckpointSummary(chatId: number, agentId: string): string | null {
  const acc = tokenAccounts.get(accountKey(chatId, agentId));
  if (!acc) return null;
  const s = acc.pendingSummary;
  acc.pendingSummary = null;
  return s;
}

export function resetTokenAccount(chatId: number, agentId: string): void {
  const acc = tokenAccounts.get(accountKey(chatId, agentId));
  if (acc) acc.total = 0;
}

const agentHealth = new Map<string, AgentHealth>();
for (const id of AGENT_IDS) {
  agentHealth.set(id, {
    agentId:         id,
    state:           'idle',
    lastTask:        null,
    lastError:       null,
    restartAttempts: 0,
    lastTransition:  Date.now(),
    pid:             null,
  });
}

type AlertFn = (message: string) => void;
let alertFn: AlertFn | null = null;

export function setAlertHandler(fn: AlertFn | null): void {
  alertFn = fn;
}

export function listAgentHealth(): AgentHealth[] {
  return Array.from(agentHealth.values()).map(h => ({ ...h }));
}

export function getAgentHealth(agentId: string): AgentHealth | null {
  const h = agentHealth.get(agentId);
  return h ? { ...h } : null;
}

export function markAgentBusy(agentId: string, task: string): void {
  const h = agentHealth.get(agentId);
  if (!h) return;
  h.state = 'busy';
  h.lastTask = task.slice(0, 200);
  h.lastTransition = Date.now();
}

export function setAgentPid(agentId: string, pid: number | null): void {
  const h = agentHealth.get(agentId);
  if (!h) return;
  h.pid = pid;
}

export function markAgentIdle(agentId: string): void {
  const h = agentHealth.get(agentId);
  if (!h) return;
  h.state = 'idle';
  h.lastError = null;
  h.pid = null;
  h.restartAttempts = 0;
  h.lastTransition = Date.now();
}

export function markAgentFaulted(agentId: string, error: string): void {
  const h = agentHealth.get(agentId);
  if (!h) return;
  h.state = 'faulted';
  h.lastError = error.slice(0, 400);
  h.pid = null;
  h.lastTransition = Date.now();

  if (h.restartAttempts >= MAX_RESTART_ATTEMPTS) {
    const msg = `Agent @${agentId} exhausted ${MAX_RESTART_ATTEMPTS} restart attempts. Stays faulted.\nLast error: ${h.lastError}`;
    console.warn(`[agent-pool] ${msg}`);
    try { alertFn?.(`⚠️ ${msg}`); } catch { /* noop */ }
    return;
  }

  setTimeout(() => {
    const cur = agentHealth.get(agentId);
    if (!cur || cur.state !== 'faulted') return;
    cur.state = 'restarting';
    cur.restartAttempts += 1;
    cur.lastTransition = Date.now();
    console.log(`[agent-pool] restart ${agentId} (attempt ${cur.restartAttempts}/${MAX_RESTART_ATTEMPTS})`);
    setTimeout(() => {
      const c = agentHealth.get(agentId);
      if (!c || c.state !== 'restarting') return;
      c.state = 'idle';
      c.lastTransition = Date.now();
    }, 50);
  }, RESTART_DELAY_MS);
}

export async function runSubprocessPool(tasks: PoolTask[]): Promise<PoolResult[]> {
  if (tasks.length > MAX_CONCURRENT) {
    throw new Error(`runSubprocessPool: max ${MAX_CONCURRENT} tasks, got ${tasks.length}`);
  }
  return Promise.all(tasks.map((t, i) => runOne(t, i * STAGGER_MS)));
}

function runOne(task: PoolTask, startDelay: number): Promise<PoolResult> {
  return new Promise(resolve => {
    setTimeout(async () => {
      const start = Date.now();

      const h = agentHealth.get(task.id);
      if (h && h.state === 'faulted') {
        resolve({
          id:           task.id,
          output:       `[skipped — agent ${task.id} is faulted]`,
          exitCode:     -1,
          durationMs:   0,
          sentinelSeen: false,
          timedOut:     false,
        });
        return;
      }

      markAgentBusy(task.id, task.prompt);
      const req = createTaskRequest(task.prompt);

      const run = await runAgentEnvelope(req, {
        agentId:      task.id,
        model:        task.model,
        systemPrompt: task.systemAppend,
        allowedTools: task.allowedTools,
        cwd:          task.cwd,
        onEnvelope:   task.onEnvelope,
        onStart:      (pid) => setAgentPid(task.id, pid),
      });

      const doneEnv = run.envelopes.find(e => e.type === 'done');
      const errorEnv = run.envelopes.find(e => e.type === 'error');

      if (run.isError || run.timedOut) {
        const reason = run.timedOut ? 'timeout' : (errorEnv?.payload || 'unknown error');
        markAgentFaulted(task.id, reason);
      } else {
        markAgentIdle(task.id);
      }

      resolve({
        id:           task.id,
        output:       (doneEnv?.payload ?? run.finalResponse ?? '').trim(),
        exitCode:     run.isError ? -1 : 0,
        durationMs:   Date.now() - start,
        sentinelSeen: !!doneEnv,
        timedOut:     run.timedOut,
      });
    }, startDelay);
  });
}
