import { v4 as uuidv4 } from 'uuid';
import cronParser from 'cron-parser';
import {
  getEnabledScheduledTasks, updateScheduledTaskRun, insertScheduledTask,
  getQueuedMissions, updateMissionStatus, getStuckMissions, incrementMissionRetry,
  insertAuditLog, ScheduledTask, MissionTask,
} from './db';
import { dispatch } from './orchestrator';
import { config } from './config';

const SCHEDULER_TICK_MS = 60_000;
const MISSION_TICK_MS = 10_000;
const MAX_CONCURRENT_MISSIONS = 3;
const MISSION_TIMEOUT_MS = 30 * 60_000;
const MAX_MISSION_RETRIES = 2;

let schedulerTimer: NodeJS.Timeout | null = null;
let missionTimer: NodeJS.Timeout | null = null;
const inFlightMissions: Set<string> = new Set();

export function computeNextRun(cronExpr: string, from = new Date()): number {
  const it = cronParser.parseExpression(cronExpr, { currentDate: from });
  return it.next().getTime();
}

export function scheduleTask(opts: {
  name: string;
  cronExpr: string;
  agentId: string;
  prompt: string;
}): string {
  const id = uuidv4();
  const now = Date.now();
  const task: ScheduledTask = {
    id,
    name: opts.name,
    cron_expr: opts.cronExpr,
    agent_id: opts.agentId,
    prompt: opts.prompt,
    enabled: 1,
    last_run: null,
    next_run: computeNextRun(opts.cronExpr, new Date(now)),
    created_at: now,
  };
  insertScheduledTask(task);
  return id;
}

async function runScheduledTask(task: any): Promise<void> {
  const now = Date.now();
  try {
    const chatId = config.allowedChatIds[0] ?? 0;
    const outcome = await dispatch({ chatId, text: task.prompt });
    insertAuditLog(chatId, task.agent_id, 'scheduled_task_ran', `${task.name} → ${String(outcome.response || '').slice(0, 80)}`);
  } catch (err: any) {
    insertAuditLog(null, task.agent_id, 'scheduled_task_failed', `${task.name}: ${err?.message || err}`.slice(0, 200));
  } finally {
    const next = computeNextRun(task.cron_expr, new Date(now));
    updateScheduledTaskRun(task.id, now, next);
  }
}

async function schedulerTick(): Promise<void> {
  const tasks = getEnabledScheduledTasks();
  const now = Date.now();
  for (const t of tasks) {
    if (t.next_run && t.next_run <= now) {
      void runScheduledTask(t);
    }
  }
}

async function runMission(mission: any): Promise<void> {
  const { id, agent_id, prompt, title, retry_count } = mission;
  inFlightMissions.add(id);
  updateMissionStatus(id, 'running');
  try {
    const chatId = config.allowedChatIds[0] ?? 0;
    const outcome = await dispatch({
      chatId,
      text: agent_id ? `@${agent_id} ${prompt}` : prompt,
    });
    updateMissionStatus(id, 'completed', outcome.response);
    insertAuditLog(chatId, agent_id || 'main', 'mission_completed', `${title} (${id.slice(0, 8)})`);
  } catch (err: any) {
    const priorRetries = Number(retry_count) || 0;
    if (priorRetries >= MAX_MISSION_RETRIES) {
      updateMissionStatus(id, 'failed', String(err?.message || err));
      insertAuditLog(null, agent_id || 'main', 'mission_failed', `${title}: ${err?.message || err}`.slice(0, 200));
    } else {
      incrementMissionRetry(id);
      insertAuditLog(null, agent_id || 'main', 'mission_retry', `${title}: retry ${priorRetries + 1}`);
    }
  } finally {
    inFlightMissions.delete(id);
  }
}

async function missionTick(): Promise<void> {
  const stuck = getStuckMissions(MISSION_TIMEOUT_MS);
  for (const m of stuck) {
    if (!inFlightMissions.has(m.id)) {
      updateMissionStatus(m.id, 'queued');
      insertAuditLog(null, m.agent_id || 'main', 'mission_requeued_stuck', m.id.slice(0, 8));
    }
  }

  const slots = MAX_CONCURRENT_MISSIONS - inFlightMissions.size;
  if (slots <= 0) return;
  const queued = getQueuedMissions(slots);
  for (const m of queued) {
    if (!inFlightMissions.has(m.id)) void runMission(m);
  }
}

export function startScheduler(): void {
  stopScheduler();
  schedulerTimer = setInterval(() => { void schedulerTick().catch(err => console.error('[scheduler] tick:', err?.message || err)); }, SCHEDULER_TICK_MS);
  missionTimer = setInterval(() => { void missionTick().catch(err => console.error('[mission] tick:', err?.message || err)); }, MISSION_TICK_MS);
  console.log(`[scheduler] started — scheduler tick ${SCHEDULER_TICK_MS}ms, mission tick ${MISSION_TICK_MS}ms, max concurrent ${MAX_CONCURRENT_MISSIONS}`);
}

export function stopScheduler(): void {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
  if (missionTimer) { clearInterval(missionTimer); missionTimer = null; }
}

export function queueMission(opts: {
  title: string;
  prompt: string;
  agentId?: string;
  priority?: number;
}): string {
  const id = uuidv4();
  const mission: MissionTask = {
    id,
    title: opts.title,
    prompt: opts.prompt,
    agent_id: opts.agentId ?? null,
    priority: opts.priority ?? 5,
    status: 'queued',
    result: null,
    created_at: Date.now(),
  };
  // insertMissionTask is in db.ts
  const { insertMissionTask } = require('./db');
  insertMissionTask(mission);
  return id;
}
