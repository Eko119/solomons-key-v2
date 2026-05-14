import {
  getScrapeJob,
  startScrapeJob,
  completeScrapeJob,
  failScrapeJob,
  getPendingScrapeJobs,
  upsertLead,
} from './db';
import { dispatchToAgent } from './orchestrator';

interface ProspectorEntry {
  profileUrl?: string;
  displayName?: string;
  bio?: string;
  followerCount?: number;
  recentPosts?: string[];
}

export async function runScrapeJob(jobId: number): Promise<void> {
  const job = getScrapeJob(jobId);
  if (!job) {
    console.warn(`[scraper] runScrapeJob: jobId ${jobId} not found`);
    return;
  }
  if (job.status !== 'pending') {
    console.warn(`[scraper] runScrapeJob: jobId ${jobId} status=${job.status}, skipping`);
    return;
  }

  startScrapeJob(jobId);

  try {
    const prompt = [
      `You are the prospector agent. Find up to ${job.maxLeads} prospective leads on ${job.platform}`,
      `matching these search targets: ${JSON.stringify(job.searchTargets)}.`,
      ``,
      `Return ONLY a JSON array (no prose, no markdown fences) of objects with this shape:`,
      `[{ "profileUrl": "https://...", "displayName": "...", "bio": "...", "followerCount": 0, "recentPosts": ["...", "..."] }]`,
      ``,
      `Required fields per entry: profileUrl. All other fields are optional.`,
      `If you find fewer than ${job.maxLeads} leads, return what you have. If none, return [].`,
    ].join('\n');

    const raw = await dispatchToAgent('prospector', prompt);

    let entries: ProspectorEntry[];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      entries = parsed;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[scraper] job ${jobId} invalid JSON: ${msg}`);
      failScrapeJob(jobId, `invalid JSON: ${msg}`);
      return;
    }

    let leadsFound = 0;
    for (const entry of entries) {
      if (!entry || typeof entry.profileUrl !== 'string' || !entry.profileUrl) {
        console.warn(`[scraper] job ${jobId} skipping entry missing profileUrl`);
        continue;
      }
      const result = upsertLead({
        clientId: job.clientId,
        platform: job.platform,
        profileUrl: entry.profileUrl,
        displayName: entry.displayName,
        bio: entry.bio,
        followerCount: entry.followerCount,
        recentPosts: entry.recentPosts,
      });
      if (result.isNew) leadsFound++;
    }

    completeScrapeJob(jobId, leadsFound);
    console.log(`[scraper] job ${jobId} completed: ${leadsFound} new leads`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scraper] job ${jobId} failed: ${msg}`);
    failScrapeJob(jobId, msg);
  }
}

export async function drainScrapeQueue(): Promise<void> {
  const pending = getPendingScrapeJobs();
  for (const job of pending) {
    try {
      await runScrapeJob(job.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scraper] drainScrapeQueue: job ${job.id} unhandled: ${msg}`);
      failScrapeJob(job.id, msg);
    }
  }
}
