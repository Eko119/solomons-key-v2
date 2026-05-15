import { getClient, schedulePost } from './db';
import { dispatchToAgent } from './orchestrator';

interface CalendarItem {
  postText?: unknown;
  scheduledFor?: unknown;
}

export async function generateContentCalendar(
  clientId: string,
  platform: string
): Promise<{ scheduled: number; skipped: number; error?: string }> {
  const client = getClient(clientId);
  if (!client) {
    return { scheduled: 0, skipped: 0, error: 'client_not_found' };
  }

  const startDate = new Date().toISOString().slice(0, 10);
  const prompt = [
    `You are the content-scheduler agent for ${client.name} (${client.industry}, brand voice: ${client.brandVoice}).`,
    `Generate a 14-day posting calendar for ${platform}, starting ${startDate}.`,
    ``,
    `Return ONLY a JSON array (no prose, no markdown fences) of 14 objects:`,
    `[{ "postText": "...", "scheduledFor": "2026-05-14T13:00:00Z" }]`,
    ``,
    `Rules:`,
    `- One entry per day for 14 consecutive days.`,
    `- postText is the full post body, ready to publish.`,
    `- scheduledFor is an ISO-8601 timestamp parseable by JavaScript's Date constructor.`,
    `- Match the brand voice and the platform's norms (length, hashtags, etc.).`,
    `- No duplicate days. No timestamps in the past.`,
  ].join('\n');

  let raw: string;
  try {
    raw = await dispatchToAgent('content-scheduler', prompt);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[content-scheduler] client ${clientId} dispatch failed: ${msg}`);
    return { scheduled: 0, skipped: 0, error: msg };
  }

  let items: CalendarItem[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    items = parsed;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[content-scheduler] client ${clientId} invalid JSON: ${msg}`);
    return { scheduled: 0, skipped: 0, error: msg };
  }

  let scheduled = 0;
  let skipped = 0;

  for (const item of items) {
    const postText = typeof item.postText === 'string' ? item.postText.trim() : '';
    if (!postText) {
      skipped++;
      continue;
    }
    const ts = typeof item.scheduledFor === 'string' || typeof item.scheduledFor === 'number'
      ? new Date(item.scheduledFor as string | number).getTime()
      : NaN;
    if (!Number.isFinite(ts)) {
      skipped++;
      continue;
    }
    schedulePost({ clientId, platform, postText, scheduledFor: ts });
    scheduled++;
  }

  console.log(`[content-scheduler] client ${clientId} ${platform}: scheduled=${scheduled} skipped=${skipped}`);
  return { scheduled, skipped };
}
