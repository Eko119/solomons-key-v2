import TelegramBot from 'node-telegram-bot-api';
import { config } from './config';
import {
  handleAuth, handlePinAttempt, checkKillPhrase, isAllowedChatId,
  sanitizeInbound,
} from './security';
import { dispatch, listAvailableSpecialists } from './orchestrator';
import { formatCostFooter } from './agent';
import { scanForSecrets } from './exfiltration-guard';
import { insertAuditLog, lockAllSessions } from './db';

const TELEGRAM_MSG_CAP = 3800;
const pendingPin: Map<number, { agentId: string }> = new Map();
const queues: Map<number, Promise<void>> = new Map();

function enqueue(chatId: number, job: () => Promise<void>): Promise<void> {
  const prev = queues.get(chatId) || Promise.resolve();
  const next = prev.then(job, job).catch(() => { /* already logged */ });
  queues.set(chatId, next);
  return next;
}

function chunk(s: string): string[] {
  if (s.length <= TELEGRAM_MSG_CAP) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += TELEGRAM_MSG_CAP) out.push(s.slice(i, i + TELEGRAM_MSG_CAP));
  return out;
}

async function send(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  for (const piece of chunk(text)) {
    await bot.sendMessage(chatId, piece, { parse_mode: undefined });
  }
}

function helpText(): string {
  return [
    "Solomon's Key — commands:",
    '/start — begin session (PIN challenge)',
    '/help — this message',
    '/status — session info',
    '/lock — lock this session',
    '/agents — list specialists',
    '',
    'Message any agent by prefix, e.g. @research what is 2+2',
    'No prefix → main orchestrator handles it.',
  ].join('\n');
}

export function startBot(): TelegramBot {
  const bot = new TelegramBot(config.telegramBotToken, { polling: true });

  bot.on('polling_error', (err: any) => {
    console.error(`[bot] polling error: ${err?.message || err}`);
  });

  bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text) return;

    if (!isAllowedChatId(chatId)) {
      insertAuditLog(chatId, null, 'blocked_chat_id', text.slice(0, 80));
      return;
    }

    enqueue(chatId, () => handleMessage(bot, chatId, text));
  });

  console.log(`[bot] started — polling Telegram for ${config.allowedChatIds.length} allowed chat(s)`);
  return bot;
}

async function handleMessage(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  try {
    if (checkKillPhrase(text)) {
      lockAllSessions();
      insertAuditLog(chatId, null, 'kill_phrase_triggered');
      pendingPin.clear();
      await send(bot, chatId, '🔴 Kill phrase received. All sessions locked.');
      return;
    }

    const pending = pendingPin.get(chatId);
    if (pending) {
      const res = handlePinAttempt(chatId, pending.agentId, text);
      if (res.success) pendingPin.delete(chatId);
      await send(bot, chatId, res.message);
      return;
    }

    if (text.startsWith('/')) {
      await handleCommand(bot, chatId, text);
      return;
    }

    const auth = handleAuth(chatId, 'main', text);
    if (!auth.allowed) {
      if (auth.requirePin) pendingPin.set(chatId, { agentId: 'main' });
      if (auth.message) await send(bot, chatId, auth.message);
      return;
    }

    const inbound = sanitizeInbound(text);
    if (!inbound.safe) {
      insertAuditLog(chatId, 'main', 'inbound_rejected', inbound.reason ?? 'unknown');
      console.warn(`[bot] inbound rejected (reason=${inbound.reason ?? 'unknown'})`);
      await send(bot, chatId, 'Message rejected.');
      return;
    }

    const inputScan = scanForSecrets(text);
    if (inputScan.found) {
      insertAuditLog(chatId, 'main', 'exfil_input_blocked', inputScan.matches.join(','));
      await send(bot, chatId, '⚠️ Your message looked like it contained secrets. Not forwarding to agents.');
      return;
    }

    const outcome = await dispatch({ chatId, text });
    let response = outcome.response || '[no response]';
    if (!outcome.blocked && outcome.result) {
      response += formatCostFooter(outcome.result, config.costFooterMode);
    }
    await send(bot, chatId, response);
  } catch (err: any) {
    console.error(`[bot] handler error: ${err?.message || err}`);
    insertAuditLog(chatId, null, 'handler_error', String(err?.message || err).slice(0, 200));
    try { await send(bot, chatId, `⚠️ error: ${err?.message || err}`); } catch { /* noop */ }
  }
}

async function handleCommand(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  const [cmd] = text.split(/\s+/, 1);
  switch (cmd.toLowerCase()) {
    case '/start':
      pendingPin.set(chatId, { agentId: 'main' });
      await send(bot, chatId, "🔐 Welcome to Solomon's Key. Enter your PIN to unlock.");
      return;
    case '/help':
      await send(bot, chatId, helpText());
      return;
    case '/status': {
      const auth = handleAuth(chatId, 'main', '');
      const status = auth.allowed ? '🟢 unlocked' : '🔒 locked';
      await send(bot, chatId, `Session: ${status}\nChat ID: ${chatId}`);
      return;
    }
    case '/lock': {
      lockAllSessions();
      pendingPin.clear();
      await send(bot, chatId, '🔒 All sessions locked.');
      return;
    }
    case '/agents':
      await send(bot, chatId, `Specialists:\n${listAvailableSpecialists()}`);
      return;
    default:
      await send(bot, chatId, `Unknown command: ${cmd}. Try /help.`);
  }
}
