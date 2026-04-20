import { runAgentEnvelope, createTaskRequest } from './agent-create';
import { AgentResponse } from './agent-config';

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

const STAGGER_MS = 3_000;
const MAX_CONCURRENT = 5;

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
      const req = createTaskRequest(task.prompt);

      const run = await runAgentEnvelope(req, {
        agentId:      task.id,
        model:        task.model,
        systemPrompt: task.systemAppend,
        allowedTools: task.allowedTools,
        cwd:          task.cwd,
        onEnvelope:   task.onEnvelope,
      });

      const doneEnv = run.envelopes.find(e => e.type === 'done');

      resolve({
        id:           task.id,
        output:       (run.finalResponse || doneEnv?.payload || '').trim(),
        exitCode:     run.isError ? -1 : 0,
        durationMs:   Date.now() - start,
        sentinelSeen: !!doneEnv,
        timedOut:     run.timedOut,
      });
    }, startDelay);
  });
}
