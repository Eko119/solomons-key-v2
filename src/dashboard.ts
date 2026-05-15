import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { config } from './config';
import { DASHBOARD_HTML } from './dashboard-html';
import {
  rawDb, listMissions, getActiveMissions, getAuditLog,
  getAllAgentActivity, getTotalUsage, getDailyCost, listScheduledTasks,
  getMemoriesByAgent,
  getClient, getLatestAnalytics, getLeadStatusCounts, getOutreachCounts,
  getAllClients, updateClient, createClient,
  getLeadsByStatus, getScheduledPosts,
  listOutreachQueue, approveOutreach, rejectOutreach, markOutreachSent,
  listScrapeJobs, createScrapeJob,
} from './db';
import { listAgents } from './agent-config';
import { listAgentHealth } from './agent-pool';
import { isWarroomAvailable } from './agent-voice-bridge';
import { getMcpStatus } from './orchestrator';
import { runScrapeJob } from './scraper';
import { draftOutreachForClient } from './outreach';
import { generateContentCalendar } from './content-scheduler';
import { generateWeeklyReport } from './analyst';

export function buildApp(): Hono {
  const app = new Hono();

  app.get('/health', c => c.text('OK', 200));

  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    const provided = c.req.header('x-dashboard-token') || new URL(c.req.url).searchParams.get('token') || '';
    if (provided !== config.dashboardToken) {
      return c.text('unauthorized', 401);
    }
    return next();
  });

  app.get('/', c => c.html(DASHBOARD_HTML));

  app.get('/api/status', c => {
    const agents = listAgents().map(a => ({
      id: a.id, title: a.title, model: a.model, tools: a.tools, role: a.role,
    }));
    const sessions = rawDb().prepare('SELECT chat_id, agent_id, last_activity, locked FROM sessions ORDER BY last_activity DESC LIMIT 20').all();
    const warroom: 'up' | 'down' = isWarroomAvailable() ? 'up' : 'down';
    const mcp = getMcpStatus();
    return c.json({ agents, sessions, warroom, mcp });
  });

  app.get('/api/agents', c => {
    const defs = new Map(listAgents().map(a => [a.id, a]));
    const rows = listAgentHealth().map(h => {
      const def = defs.get(h.agentId);
      return {
        id:              h.agentId,
        title:           def?.title ?? h.agentId,
        model:           def?.model ?? null,
        state:           h.state,
        lastTask:        h.lastTask,
        lastError:       h.lastError,
        restartAttempts: h.restartAttempts,
        lastTransition:  h.lastTransition,
        pid:             h.pid,
      };
    });
    return c.json({ agents: rows });
  });

  app.get('/api/missions', c => {
    const active = c.req.query('active') === '1';
    const limit = parseInt(c.req.query('limit') || '25', 10);
    const rows = active ? getActiveMissions() : listMissions(isNaN(limit) ? 25 : limit);
    return c.json({ rows });
  });

  app.get('/api/schedule', c => {
    return c.json({ rows: listScheduledTasks() });
  });

  app.get('/api/usage', c => {
    const total = getTotalUsage();
    const daily = getDailyCost();
    return c.json({ total, daily });
  });

  app.get('/api/hive', c => {
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const rows = getAllAgentActivity(isNaN(limit) ? 50 : limit);
    return c.json({ rows });
  });

  app.get('/api/audit', c => {
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const rows = getAuditLog(isNaN(limit) ? 100 : limit);
    return c.json({ rows });
  });

  app.get('/api/memories', c => {
    const agentId = c.req.query('agent') || 'main';
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const rows = getMemoriesByAgent(agentId, isNaN(limit) ? 50 : limit);
    return c.json({ rows });
  });

  app.get('/api/marketing/clients/:clientId/summary', c => {
    const clientId = c.req.param('clientId');
    const client = getClient(clientId);
    if (!client) return c.json({ error: 'not_found' }, 404);

    const byStatus = getLeadStatusCounts(clientId);
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const o = getOutreachCounts(clientId);
    const replyRate = o.sent === 0 ? 0 : Math.round((o.replied / o.sent) * 10000) / 10000;
    const conversionRate = o.sent === 0 ? 0 : Math.round((o.converted / o.sent) * 10000) / 10000;

    const a = getLatestAnalytics(clientId);
    return c.json({
      client: {
        id: client.id,
        name: client.name,
        industry: client.industry,
        targetPlatform: client.targetPlatform,
      },
      leads: { total, byStatus },
      outreach: {
        sent: o.sent,
        replied: o.replied,
        converted: o.converted,
        replyRate,
        conversionRate,
      },
      latestAnalytics: a ? {
        periodStart: a.periodStart,
        periodEnd: a.periodEnd,
        topPerformingHook: a.topPerformingHook,
      } : null,
    });
  });

  // ── P5-T1: marketing API routes ─────────────────────────────────────────

  const PLATFORM_ENUM = z.enum(['instagram', 'twitter', 'linkedin', 'tiktok']);
  const LEAD_STATUSES = ['unprocessed', 'enriched', 'queued', 'sent', 'replied', 'converted', 'disqualified'] as const;
  const OUTREACH_STATUSES = ['pending', 'approved', 'sent', 'rejected'] as const;

  app.get('/api/marketing/clients', c => {
    return c.json({ clients: getAllClients() });
  });

  app.post('/api/marketing/clients', async c => {
    const schema = z.object({
      name: z.string().min(1),
      industry: z.string().min(1),
      targetPlatform: PLATFORM_ENUM,
      brandVoice: z.string().min(1),
    });
    const body = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);
    const id = createClient(body.data);
    return c.json({ id }, 201);
  });

  app.get('/api/marketing/clients/:clientId/leads', c => {
    const clientId = c.req.param('clientId');
    const status = c.req.query('status');
    if (status) {
      if (!(LEAD_STATUSES as readonly string[]).includes(status)) {
        return c.json({ error: 'invalid_status' }, 400);
      }
      return c.json({ leads: getLeadsByStatus(clientId, status as typeof LEAD_STATUSES[number]) });
    }
    const all = LEAD_STATUSES.flatMap(s => getLeadsByStatus(clientId, s));
    return c.json({ leads: all });
  });

  app.get('/api/marketing/clients/:clientId/outreach', c => {
    const clientId = c.req.param('clientId');
    const status = c.req.query('status');
    if (status && !(OUTREACH_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: 'invalid_status' }, 400);
    }
    return c.json({
      queue: listOutreachQueue(clientId, status as typeof OUTREACH_STATUSES[number] | undefined),
    });
  });

  app.post('/api/marketing/clients/:clientId/outreach/:queueId/approve', c => {
    const queueId = parseInt(c.req.param('queueId'), 10);
    if (!Number.isFinite(queueId)) return c.json({ error: 'invalid_queue_id' }, 400);
    approveOutreach(queueId);
    return c.json({ approved: true });
  });

  app.post('/api/marketing/clients/:clientId/outreach/:queueId/reject', async c => {
    const queueId = parseInt(c.req.param('queueId'), 10);
    if (!Number.isFinite(queueId)) return c.json({ error: 'invalid_queue_id' }, 400);
    const schema = z.object({ note: z.string().optional() });
    const body = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);
    rejectOutreach(queueId, body.data.note ?? '');
    return c.json({ rejected: true });
  });

  app.post('/api/marketing/clients/:clientId/outreach/:queueId/sent', c => {
    const queueId = parseInt(c.req.param('queueId'), 10);
    if (!Number.isFinite(queueId)) return c.json({ error: 'invalid_queue_id' }, 400);
    markOutreachSent(queueId);
    return c.json({ sent: true });
  });

  app.post('/api/marketing/clients/:clientId/outreach/draft', c => {
    const clientId = c.req.param('clientId');
    void draftOutreachForClient(clientId).catch(err => {
      console.error(`[dashboard] draftOutreachForClient ${clientId} failed:`, err);
    });
    return c.json({ queued: true }, 202);
  });

  app.get('/api/marketing/clients/:clientId/calendar', c => {
    const clientId = c.req.param('clientId');
    const fromRaw = c.req.query('from');
    const toRaw = c.req.query('to');
    const from = fromRaw ? parseInt(fromRaw, 10) || 0 : 0;
    const to = toRaw ? parseInt(toRaw, 10) || Date.now() + 14 * 86400000 : Date.now() + 14 * 86400000;
    return c.json({ posts: getScheduledPosts(clientId, from, to) });
  });

  app.post('/api/marketing/clients/:clientId/calendar/generate', async c => {
    const clientId = c.req.param('clientId');
    const schema = z.object({ platform: PLATFORM_ENUM });
    const body = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);
    void generateContentCalendar(clientId, body.data.platform).catch(err => {
      console.error(`[dashboard] generateContentCalendar ${clientId} failed:`, err);
    });
    return c.json({ queued: true }, 202);
  });

  app.post('/api/marketing/clients/:clientId/scrape', async c => {
    const clientId = c.req.param('clientId');
    const schema = z.object({
      platform: PLATFORM_ENUM,
      searchTargets: z.array(z.string()).min(1),
      maxLeads: z.number().int().positive().optional(),
    });
    const body = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);
    try {
      const jobId = createScrapeJob({ clientId, ...body.data });
      void runScrapeJob(jobId).catch(err => {
        console.error(`[dashboard] runScrapeJob ${jobId} failed:`, err);
      });
      return c.json({ queued: true, jobId }, 202);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'DUPLICATE_SCRAPE_JOB') return c.json({ error: 'duplicate_scrape_job' }, 409);
      if (code === 'INVALID_SEARCH_TARGETS') return c.json({ error: 'invalid_search_targets' }, 400);
      throw err;
    }
  });

  app.get('/api/marketing/clients/:clientId/scrape/jobs', c => {
    return c.json({ jobs: listScrapeJobs(c.req.param('clientId')) });
  });

  app.get('/api/marketing/clients/:clientId/report', async c => {
    try {
      const result = await generateWeeklyReport(c.req.param('clientId'));
      return c.json({ report: result.report, generatedAt: result.generatedAt });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'CLIENT_NOT_FOUND') return c.json({ error: 'not_found' }, 404);
      throw err;
    }
  });

  app.get('/api/marketing/clients/:clientId/settings', c => {
    const client = getClient(c.req.param('clientId'));
    if (!client) return c.json({ error: 'not_found' }, 404);
    return c.json({ client });
  });

  app.post('/api/marketing/clients/:clientId/settings', async c => {
    const clientId = c.req.param('clientId');
    const schema = z.object({
      name: z.string().optional(),
      industry: z.string().optional(),
      targetPlatform: PLATFORM_ENUM.optional(),
      brandVoice: z.string().optional(),
    });
    const body = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);
    if (!getClient(clientId)) return c.json({ error: 'not_found' }, 404);
    updateClient(clientId, body.data);
    return c.json({ updated: true });
  });

  return app;
}

export interface DashboardHandle {
  close(): void;
  port: number;
}

export function startDashboard(port?: number): DashboardHandle {
  const app = buildApp();
  const bindPort = port ?? config.dashboardPort;
  const server = serve({ fetch: app.fetch, port: bindPort, hostname: '127.0.0.1' });
  console.log(`[dashboard] listening on http://127.0.0.1:${bindPort}`);
  return {
    port: bindPort,
    close: () => { try { (server as any).close?.(); } catch { /* noop */ } },
  };
}
