import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.env.PROJECT_ROOT || process.cwd(), '.env') });

const REQUIRED_KEYS = [
  'ANTHROPIC_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  'GOOGLE_API_KEY',
  'PIN_HASH',
  'KILL_PHRASE',
  'DASHBOARD_TOKEN',
];

export function validateConfig(): void {
  const missing = REQUIRED_KEYS.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[CONFIG ERROR] Missing required environment variables:\n${missing.map(k => `  - ${k}`).join('\n')}`);
    process.exit(1);
  }
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
  allowedChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n)),
  googleApiKey: process.env.GOOGLE_API_KEY!,
  pinHash: process.env.PIN_HASH!,
  killPhrase: process.env.KILL_PHRASE!,
  idleLockMinutes: parseInt(process.env.IDLE_LOCK_MINUTES || '30', 10),
  dashboardToken: process.env.DASHBOARD_TOKEN!,
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000', 10),

  mainModel: process.env.MAIN_MODEL || 'claude-opus-4-6',
  agentModel: process.env.AGENT_MODEL || 'claude-sonnet-4-6',
  geminiExtractModel: process.env.GEMINI_EXTRACT_MODEL || 'gemini-2.5-flash',
  geminiEmbedModel: process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001',

  agentMaxTurns: parseInt(process.env.AGENT_MAX_TURNS || '30', 10),
  agentTimeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS || '900000', 10),
  contextBudgetTokens: parseInt(process.env.CONTEXT_BUDGET_TOKENS || '150000', 10),
  costFooterMode: (process.env.COST_FOOTER_MODE || 'compact') as 'compact' | 'verbose' | 'cost' | 'full' | 'off',

  projectRoot: process.env.PROJECT_ROOT || process.cwd(),
  storePath: process.env.STORE_PATH || path.join(process.cwd(), 'store', 'solomons-key.db'),
  solomonsKeyConfig: process.env.SOLOMONS_KEY_CONFIG || path.join(process.env.HOME || '~', '.solomons-key'),

  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  cartesiaApiKey: process.env.CARTESIA_API_KEY,
  groqApiKey: process.env.GROQ_API_KEY,
  elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
  pikaDevKey: process.env.PIKA_DEV_KEY,
  recallApiKey: process.env.RECALL_API_KEY,
};
