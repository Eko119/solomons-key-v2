import { spawn } from 'child_process';
import { config } from './config';

export interface PoolTask {
  id: string;
  prompt: string;
  model?: string;
  cwd?: string;
  systemAppend?: string;
  allowedTools?: string[];
}

export interface PoolResult {
  id: string;
  output: string;
  exitCode: number | null;
  durationMs: number;
  sentinelSeen: boolean;
  timedOut: boolean;
}

const SENTINEL = '[AGENT_DONE]';
const TIMEOUT_MS = 120_000;
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
    setTimeout(() => {
      const start = Date.now();
      const append = (task.systemAppend ? task.systemAppend + '\n\n' : '') +
        `When your work is complete, print exactly ${SENTINEL} on its own final line.`;

      const args = [
        '--print',
        '--dangerously-skip-permissions',
        '--model', task.model || config.agentModel,
        '--append-system-prompt', append,
      ];
      if (task.allowedTools?.length) args.push('--allowed-tools', task.allowedTools.join(','));
      args.push('-p', task.prompt);

      const child = spawn('claude', args, {
        cwd: task.cwd || config.projectRoot,
        env: { ...process.env, ANTHROPIC_API_KEY: config.anthropicApiKey },
      });

      let output = '';
      let sentinelSeen = false;
      let timedOut = false;

      child.stdout.on('data', (d: Buffer) => {
        output += d.toString();
        if (!sentinelSeen && output.includes(SENTINEL)) {
          sentinelSeen = true;
          // Sentinel detected — give the child a brief grace window, then terminate if still running.
          setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* noop */ } }, 500);
        }
      });
      child.stderr.on('data', (d: Buffer) => { output += d.toString(); });

      const to = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* noop */ }
      }, TIMEOUT_MS);

      child.on('close', (code) => {
        clearTimeout(to);
        resolve({
          id: task.id,
          output: output.replace(SENTINEL, '').trim(),
          exitCode: code,
          durationMs: Date.now() - start,
          sentinelSeen,
          timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(to);
        resolve({
          id: task.id,
          output: `spawn error: ${err.message}`,
          exitCode: -1,
          durationMs: Date.now() - start,
          sentinelSeen: false,
          timedOut: false,
        });
      });
    }, startDelay);
  });
}
