import { createHash, timingSafeEqual } from 'crypto';
import { config } from './config';
import {
  getSession, upsertSession, updateSessionActivity, lockSession,
  lockAllSessions, insertAuditLog,
} from './db';

const PIN_SALT = 'solomons_key_salt';

export function hashPin(pin: string): string {
  return createHash('sha256').update(pin + PIN_SALT).digest('hex');
}

export function verifyPin(pin: string): boolean {
  const a = Buffer.from(hashPin(pin), 'hex');
  const b = Buffer.from(config.pinHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function checkKillPhrase(text: string): boolean {
  if (!config.killPhrase) return false;
  return text.trim().toLowerCase() === config.killPhrase.trim().toLowerCase();
}

export function isAllowedChatId(chatId: number): boolean {
  return config.allowedChatIds.includes(chatId);
}

export function isSessionValid(chatId: number, agentId: string): boolean {
  const s = getSession(chatId, agentId);
  if (!s) return false;
  if (s.locked) return false;
  const idleMs = config.idleLockMinutes * 60_000;
  if (Date.now() - s.last_activity > idleMs) {
    lockSession(chatId, agentId);
    return false;
  }
  return true;
}

export function recordPinAttempt(chatId: number, success: boolean): void {
  insertAuditLog(chatId, null, success ? 'pin_success' : 'pin_fail');
}

export interface AuthResult { allowed: boolean; requirePin: boolean; message?: string; }

export function handleAuth(chatId: number, agentId: string, text: string): AuthResult {
  if (!isAllowedChatId(chatId)) {
    insertAuditLog(chatId, agentId, 'blocked_chat_id', text.slice(0, 80));
    return { allowed: false, requirePin: false };
  }
  if (checkKillPhrase(text)) {
    lockAllSessions();
    insertAuditLog(chatId, agentId, 'kill_phrase_triggered');
    return { allowed: false, requirePin: false, message: '🔴 Kill phrase received. All sessions locked.' };
  }
  if (isSessionValid(chatId, agentId)) {
    updateSessionActivity(chatId, agentId);
    return { allowed: true, requirePin: false };
  }
  return { allowed: false, requirePin: true, message: '🔐 Enter your PIN to continue.' };
}

export function handlePinAttempt(chatId: number, agentId: string, pin: string): { success: boolean; message: string } {
  const ok = verifyPin(pin);
  recordPinAttempt(chatId, ok);
  if (!ok) return { success: false, message: '❌ Wrong PIN.' };
  upsertSession(chatId, agentId);
  return { success: true, message: '✅ Unlocked.' };
}
