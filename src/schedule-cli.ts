import { validateConfig } from './config';
import {
  listScheduledTasks, setScheduledTaskEnabled, deleteScheduledTask,
} from './db';
import { scheduleTask, computeNextRun } from './scheduler';
import { isValidAgentId } from './agent-config';

function usage(): void {
  console.log(`schedule-cli — Solomon's Key scheduled tasks

  add <name> <cron> <agent> <prompt...>
  list
  enable <id>
  disable <id>
  delete <id>

Example:
  npm run schedule -- add morning-brief "0 7 * * *" research "summarize today's news"
`);
}

function fmtDate(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toISOString();
}

function cmdList(): void {
  const rows = listScheduledTasks();
  if (!rows.length) { console.log('(no scheduled tasks)'); return; }
  for (const r of rows) {
    const flag = r.enabled ? '●' : '○';
    console.log(`${flag} ${r.id.slice(0, 8)}  ${r.name}  [${r.cron_expr}]  @${r.agent_id}`);
    console.log(`  next=${fmtDate(r.next_run)}  last=${fmtDate(r.last_run)}`);
    console.log(`  prompt: ${String(r.prompt).slice(0, 120)}`);
  }
}

function cmdAdd(argv: string[]): void {
  const [name, cronExpr, agentId, ...promptParts] = argv;
  if (!name || !cronExpr || !agentId || !promptParts.length) {
    console.error('usage: add <name> <cron> <agent> <prompt...>');
    process.exit(1);
  }
  if (!isValidAgentId(agentId)) {
    console.error(`unknown agent: ${agentId}`);
    process.exit(1);
  }
  try {
    computeNextRun(cronExpr);
  } catch (err: any) {
    console.error(`invalid cron expr: ${err?.message || err}`);
    process.exit(1);
  }
  const id = scheduleTask({ name, cronExpr, agentId, prompt: promptParts.join(' ') });
  console.log(`✓ scheduled ${name} (${id.slice(0, 8)}) — next run ${fmtDate(computeNextRun(cronExpr))}`);
}

function cmdToggle(argv: string[], enabled: boolean): void {
  const [id] = argv;
  if (!id) { console.error('usage: (enable|disable) <id>'); process.exit(1); }
  setScheduledTaskEnabled(id, enabled);
  console.log(`${enabled ? 'enabled' : 'disabled'} ${id.slice(0, 8)}`);
}

function cmdDelete(argv: string[]): void {
  const [id] = argv;
  if (!id) { console.error('usage: delete <id>'); process.exit(1); }
  deleteScheduledTask(id);
  console.log(`deleted ${id.slice(0, 8)}`);
}

function main(): void {
  validateConfig();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'add':     return cmdAdd(rest);
    case 'list':    return cmdList();
    case 'enable':  return cmdToggle(rest, true);
    case 'disable': return cmdToggle(rest, false);
    case 'delete':  return cmdDelete(rest);
    default:        return usage();
  }
}

main();
