import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import { validateConfig, config } from './config';
import {
  insertMeetSession, updateMeetSessionStatus, getActiveMeetSessions,
  getMeetSession, listMeetSessions, MeetSession,
} from './db';
import { isValidAgentId, getAgent } from './agent-config';

function usage(): void {
  console.log(`meet-cli — Solomon's Key meeting bot (dry-run scaffold)

  create --url <meet_url> [--agent <id>] [--name <bot_name>] [--voice <voice_id>]
         [--brief <path>] [--image <path>] [--platform <google|zoom|teams>]
  list [limit]
  active
  status <id>
  end <id>

Example:
  npm run meet -- create --url https://meet.google.com/abc-defg-hij --agent research \\
    --name "Archive" --brief ./briefs/today.md
`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

function detectPlatform(url: string): string {
  if (/meet\.google\.com/.test(url)) return 'google';
  if (/zoom\.us/.test(url)) return 'zoom';
  if (/teams\.microsoft\.com|teams\.live\.com/.test(url)) return 'teams';
  return 'unknown';
}

function pickProvider(): { provider: string; live: boolean } {
  if (config.pikaDevKey) return { provider: 'pika', live: true };
  if (config.recallApiKey) return { provider: 'recall', live: true };
  return { provider: 'dry-run', live: false };
}

function fmtDate(v: any): string {
  if (!v) return '—';
  if (typeof v === 'string') return v;
  try { return new Date(v).toISOString(); } catch { return String(v); }
}

function renderSession(s: any): void {
  console.log(`  ${s.id}  [${s.status}]  ${s.platform}/${s.provider}`);
  console.log(`    url: ${s.meet_url}`);
  console.log(`    agent: ${s.agent_id || '—'}  bot: ${s.bot_name || '—'}  voice: ${s.voice_id || '—'}`);
  console.log(`    brief: ${s.brief_path || '—'}  image: ${s.image_path || '—'}`);
  console.log(`    created: ${fmtDate(s.created_at)}`);
}

function resolveId(partial: string): string | null {
  if (partial.length >= 36) return partial;
  const rows = listMeetSessions(200);
  const matches = rows.filter((r: any) => r.id.startsWith(partial));
  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) return null;
  console.error(`ambiguous prefix '${partial}' — ${matches.length} matches:`);
  for (const m of matches) console.error(`  ${m.id}`);
  return null;
}

function cmdCreate(argv: string[]): void {
  const args = parseArgs(argv);
  if (!args.url) { console.error('--url is required'); process.exit(1); }
  const agentId = args.agent || 'main';
  if (!isValidAgentId(agentId)) { console.error(`unknown agent: ${agentId}`); process.exit(1); }
  if (args.brief && !fs.existsSync(args.brief)) { console.error(`brief not found: ${args.brief}`); process.exit(1); }
  if (args.image && !fs.existsSync(args.image)) { console.error(`image not found: ${args.image}`); process.exit(1); }

  const agent = getAgent(agentId);
  const { provider, live } = pickProvider();
  const id = uuidv4();
  const session: MeetSession = {
    id,
    agent_id: agentId,
    meet_url: args.url,
    bot_name: args.name || agent.title,
    voice_id: args.voice || null,
    image_path: args.image || null,
    brief_path: args.brief || null,
    status: live ? 'scheduled' : 'dry-run',
    platform: args.platform || detectPlatform(args.url),
    provider,
    created_at: new Date().toISOString(),
  };
  insertMeetSession(session);

  console.log(`✓ meeting session ${id.slice(0, 8)} recorded`);
  console.log(`  platform: ${session.platform}`);
  console.log(`  provider: ${provider}${live ? '' : ' (no key set — scaffold only)'}`);
  console.log(`  status:   ${session.status}`);
  if (!live) {
    console.log('');
    console.log('  To enable live joining, set one of:');
    console.log('    PIKA_DEV_KEY=...      (preferred)');
    console.log('    RECALL_API_KEY=...    (fallback)');
  }
}

function cmdList(argv: string[]): void {
  const limit = parseInt(argv[0] || '20', 10);
  const rows = listMeetSessions(isNaN(limit) ? 20 : limit);
  if (!rows.length) { console.log('(no meeting sessions)'); return; }
  for (const r of rows) renderSession(r);
}

function cmdActive(): void {
  const rows = getActiveMeetSessions();
  if (!rows.length) { console.log('(no active meeting sessions)'); return; }
  for (const r of rows) renderSession(r);
}

function cmdStatus(argv: string[]): void {
  const [partial] = argv;
  if (!partial) { console.error('usage: status <id>'); process.exit(1); }
  const id = resolveId(partial);
  if (!id) { console.error(`not found: ${partial}`); process.exit(1); }
  const s = getMeetSession(id);
  if (!s) { console.error(`not found: ${partial}`); process.exit(1); }
  renderSession(s);
}

function cmdEnd(argv: string[]): void {
  const [partial] = argv;
  if (!partial) { console.error('usage: end <id>'); process.exit(1); }
  const id = resolveId(partial);
  if (!id) { console.error(`not found: ${partial}`); process.exit(1); }
  updateMeetSessionStatus(id, 'ended');
  console.log(`ended ${id.slice(0, 8)}`);
}

function main(): void {
  validateConfig();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'create': return cmdCreate(rest);
    case 'list':   return cmdList(rest);
    case 'active': return cmdActive();
    case 'status': return cmdStatus(rest);
    case 'end':    return cmdEnd(rest);
    default:       return usage();
  }
}

main();
