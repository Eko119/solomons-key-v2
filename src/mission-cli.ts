import { validateConfig } from './config';
import {
  listMissions, getActiveMissions, updateMissionStatus,
} from './db';
import { queueMission } from './scheduler';
import { isValidAgentId } from './agent-config';

function usage(): void {
  console.log(`mission-cli — Solomon's Key mission queue

  queue <title> <agent|-> <prompt...>        agent=- means main
  list [limit]
  active
  cancel <id>

Example:
  npm run mission -- queue "weekly-report" research "compile the weekly research digest"
`);
}

function fmtDate(ms?: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toISOString();
}

function renderMission(r: any): void {
  console.log(`  ${r.id.slice(0, 8)}  [${r.status}]  ${r.title}  @${r.agent_id || 'main'}  prio=${r.priority}`);
  console.log(`    created=${fmtDate(r.created_at)}  retries=${r.retries ?? 0}`);
  if (r.result) console.log(`    result: ${String(r.result).slice(0, 160)}`);
}

function cmdList(argv: string[]): void {
  const limit = parseInt(argv[0] || '20', 10);
  const rows = listMissions(isNaN(limit) ? 20 : limit);
  if (!rows.length) { console.log('(no missions)'); return; }
  for (const r of rows) renderMission(r);
}

function cmdActive(): void {
  const rows = getActiveMissions();
  if (!rows.length) { console.log('(no active missions)'); return; }
  for (const r of rows) renderMission(r);
}

function cmdQueue(argv: string[]): void {
  const [title, agentArg, ...promptParts] = argv;
  if (!title || !agentArg || !promptParts.length) {
    console.error('usage: queue <title> <agent|-> <prompt...>');
    process.exit(1);
  }
  const agentId = agentArg === '-' ? undefined : agentArg;
  if (agentId && !isValidAgentId(agentId)) {
    console.error(`unknown agent: ${agentId}`);
    process.exit(1);
  }
  const id = queueMission({
    title,
    prompt: promptParts.join(' '),
    agentId,
  });
  console.log(`✓ queued mission ${title} (${id.slice(0, 8)})`);
}

function cmdCancel(argv: string[]): void {
  const [id] = argv;
  if (!id) { console.error('usage: cancel <id>'); process.exit(1); }
  updateMissionStatus(id, 'cancelled');
  console.log(`cancelled ${id.slice(0, 8)}`);
}

function main(): void {
  validateConfig();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'queue':   return cmdQueue(rest);
    case 'list':    return cmdList(rest);
    case 'active':  return cmdActive();
    case 'cancel':  return cmdCancel(rest);
    default:        return usage();
  }
}

main();
