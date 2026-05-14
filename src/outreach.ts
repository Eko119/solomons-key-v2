import {
  getClient,
  getEnrichedLeads,
  enqueueOutreach,
  createOutreachEvent,
  updateLeadStatus,
  SolomonError,
} from './db';
import { dispatchToAgent } from './orchestrator';

export async function draftOutreachForClient(
  clientId: string
): Promise<{ drafted: number; skipped: number }> {
  const client = getClient(clientId);
  if (!client) {
    throw new SolomonError(`client not found: ${clientId}`, 'CLIENT_NOT_FOUND');
  }

  const leads = getEnrichedLeads(clientId);
  let drafted = 0;
  let skipped = 0;

  for (const lead of leads) {
    const prompt = [
      `You are the outreach agent for ${client.name} (${client.industry}, brand voice: ${client.brandVoice}).`,
      `Draft a short, personalized DM for the lead below.`,
      ``,
      `Lead:`,
      `- platform:    ${lead.platform}`,
      `- profileUrl:  ${lead.profileUrl}`,
      `- displayName: ${lead.displayName ?? '(unknown)'}`,
      `- bio:         ${lead.bio ?? '(none)'}`,
      `- recentPosts: ${JSON.stringify(lead.recentPosts)}`,
      ``,
      `Rules:`,
      `- Open with a specific reference to bio or a recent post — no generic flattery.`,
      `- Stay under 1000 characters.`,
      `- Match the brand voice exactly.`,
      `- Output the DM body only, no greetings like "Here is the DM:".`,
      `- If this lead is a poor fit (irrelevant niche, spammy bio, etc.), output ONLY the single word SKIP.`,
    ].join('\n');

    let raw: string;
    try {
      raw = await dispatchToAgent('outreach', prompt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[outreach] lead ${lead.id} dispatch failed: ${msg}`);
      skipped++;
      continue;
    }

    const draft = raw.trim();
    if (draft === 'SKIP' || draft.length === 0 || draft.length > 1000) {
      skipped++;
      continue;
    }

    enqueueOutreach({ clientId, leadId: lead.id, draftMessage: draft });
    createOutreachEvent({ clientId, leadId: lead.id, draftText: draft });
    updateLeadStatus(lead.id, 'queued');
    drafted++;
  }

  console.log(`[outreach] client ${clientId}: drafted=${drafted} skipped=${skipped}`);
  return { drafted, skipped };
}
