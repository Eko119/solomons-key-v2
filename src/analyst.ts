import {
  getClient,
  getLatestAnalytics,
  listOutreachQueue,
  listScrapeJobs,
  SolomonError,
} from './db';
import { dispatchToAgent } from './orchestrator';

const REQUIRED_HEADINGS = [
  'wins',
  'misses',
  'top hooks',
  'next actions',
];

export async function generateWeeklyReport(clientId: string): Promise<{
  report: string;
  generatedAt: number;
  dataSnapshot: Record<string, unknown>;
}> {
  const client = getClient(clientId);
  if (!client) {
    throw new SolomonError(`client not found: ${clientId}`, 'CLIENT_NOT_FOUND');
  }

  const analytics = getLatestAnalytics(clientId);
  const pendingCount = listOutreachQueue(clientId, 'pending').length;
  const sentCount = listOutreachQueue(clientId, 'sent').length;
  const scrapeJobs = listScrapeJobs(clientId);
  const scrapeJobCount = scrapeJobs.length;

  const prompt = [
    `You are the analyst agent. Write a weekly marketing report for ${client.name} (${client.industry}).`,
    ``,
    `Data snapshot:`,
    `- Latest analytics: ${analytics ? JSON.stringify(analytics) : '(none yet)'}`,
    `- Outreach pending: ${pendingCount}`,
    `- Outreach sent:    ${sentCount}`,
    `- Scrape jobs run:  ${scrapeJobCount}`,
    ``,
    `Write a concise markdown report with exactly these four sections (use ## headings):`,
    `## Wins`,
    `## Misses`,
    `## Top Hooks`,
    `## Next Actions`,
    ``,
    `Each section: 2-4 bullet points. Numbers must come from the data snapshot — do not invent metrics.`,
  ].join('\n');

  const report = await dispatchToAgent('analyst', prompt);

  const lower = report.toLowerCase();
  for (const heading of REQUIRED_HEADINGS) {
    if (!lower.includes(heading)) {
      console.warn(`[analyst] response missing heading: ${heading}`);
    }
  }

  return {
    report,
    generatedAt: Date.now(),
    dataSnapshot: {
      client,
      analytics,
      pendingCount,
      sentCount,
      scrapeJobCount,
    },
  };
}
