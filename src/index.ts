import { validateConfig, config } from './config';
import { startBot } from './bot';
import { startScheduler, stopScheduler } from './scheduler';
import { startDashboard } from './dashboard';
import { listAgents } from './agent-config';
import { setAlertHandler } from './agent-pool';
import { startConsolidationLoop, stopConsolidationLoop } from './memory-consolidate';
import { startMemoryRetryLoop, stopMemoryRetryLoop } from './memory-ingest';
import { voiceProviderStatus } from './voice';

async function main(): Promise<void> {
  validateConfig();

  const agents = listAgents();
  const dash = startDashboard();
  const bot = startBot();
  const alertChatId = config.allowedChatIds[0];
  if (alertChatId) {
    setAlertHandler((msg) => {
      bot.sendMessage(alertChatId, msg).catch(err => {
        console.error(`[boot] telegram alert failed: ${err?.message || err}`);
      });
    });
  }
  startScheduler();
  for (const a of agents) startConsolidationLoop(a.id);
  startMemoryRetryLoop();

  printBootManifest(dash.port);

  const shutdown = (signal: string) => {
    console.log(`\n[boot] ${signal} — shutting down`);
    try { stopScheduler(); } catch { /* noop */ }
    try { stopMemoryRetryLoop(); } catch { /* noop */ }
    for (const a of agents) { try { stopConsolidationLoop(a.id); } catch { /* noop */ } }
    try { dash.close(); } catch { /* noop */ }
    try { (bot as any).stopPolling?.(); } catch { /* noop */ }
    setTimeout(() => process.exit(0), 250);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function printBootManifest(dashPort: number): void {
  const agents = listAgents();
  const voice = voiceProviderStatus();
  const lines = [
    '',
    "═════════════════════════════════════════════════════",
    "  Solomon's Key — boot manifest",
    "═════════════════════════════════════════════════════",
    `  Project root : ${config.projectRoot}`,
    `  DB           : ${config.storePath}`,
    `  Dashboard    : http://127.0.0.1:${dashPort}  (token required)`,
    `  War Room     : ws://127.0.0.1:7860  (launch warroom/server.py separately)`,
    `  Main model   : ${config.mainModel}`,
    `  Agent model  : ${config.agentModel}`,
    `  Agents (${agents.length}):`,
    ...agents.map(a => `    · ${a.id.padEnd(9)} — ${a.title}  [${a.model}]`),
    `  Voice STT    : ${voice.stt.join(', ') || '(none)'}`,
    `  Voice TTS    : ${voice.tts.join(', ') || '(none)'}`,
    `  Chat IDs     : ${config.allowedChatIds.join(', ') || '(none)'}`,
    "═════════════════════════════════════════════════════",
    '',
  ];
  console.log(lines.join('\n'));
}

main().catch(err => {
  console.error(`[boot] fatal: ${err?.message || err}`);
  process.exit(1);
});
