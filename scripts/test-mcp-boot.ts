#!/usr/bin/env npx ts-node
/**
 * Integration test: MCP boot sequence.
 * Run: npx ts-node scripts/test-mcp-boot.ts
 * Prereq: npm run build
 */

// Stub required env vars so config.ts doesn't exit(1)
const STUBS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'test-key',
  TELEGRAM_BOT_TOKEN: 'test',
  TELEGRAM_ALLOWED_CHAT_IDS: '1',
  GOOGLE_API_KEY: 'test',
  PIN_HASH: 'test',
  KILL_PHRASE: 'test',
  DASHBOARD_TOKEN: 'test',
  MCP_CONFIG_PATH: './mcp-servers.json',
  PROJECT_ROOT: process.cwd(),
  STORE_PATH: ':memory:',
};
for (const [k, v] of Object.entries(STUBS)) {
  if (!process.env[k]) process.env[k] = v;
}

async function main(): Promise<void> {
  const { bootMcpServers, getMcpStatus, getMcpConfigForAgent } = require('../dist/orchestrator');

  console.log('[test] booting MCP servers...');
  await bootMcpServers();

  const status: { name: string; healthy: boolean; toolCount: number }[] = getMcpStatus();
  console.log('[test] MCP status:', JSON.stringify(status, null, 2));

  if (status.length === 0) {
    console.error('[FAIL] no MCP servers loaded — is MCP_CONFIG_PATH set?');
    process.exit(1);
  }

  const unhealthy = status.filter(s => !s.healthy);
  if (unhealthy.length > 0) {
    console.error(`[FAIL] ${unhealthy.length} server(s) unhealthy:`, unhealthy.map(s => s.name).join(', '));
    process.exit(1);
  }

  const researchConfig = getMcpConfigForAgent('research');
  console.log('[test] research agent MCP config:', JSON.stringify(researchConfig));
  if (researchConfig.length === 0) {
    console.error('[FAIL] research agent should have filesystem MCP server');
    process.exit(1);
  }

  const opsConfig = getMcpConfigForAgent('ops');
  if (opsConfig.length !== 0) {
    console.error('[FAIL] ops agent should have no MCP servers');
    process.exit(1);
  }

  const fs = status.find(s => s.name === 'filesystem');
  if (!fs || fs.toolCount === 0) {
    console.error('[FAIL] filesystem server has 0 tools');
    process.exit(1);
  }

  console.log(`[PASS] ${status.length} server(s) healthy, ${fs.toolCount} tools available`);
  console.log('[PASS] agent routing correct — research gets filesystem, ops gets nothing');
  process.exit(0);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[FAIL] unhandled error: ${msg}`);
  process.exit(1);
});
