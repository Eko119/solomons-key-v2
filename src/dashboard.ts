import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { config } from './config';
import { DASHBOARD_HTML } from './dashboard-html';
import {
  rawDb, listMissions, getActiveMissions, getAuditLog,
  getAllAgentActivity, getTotalUsage, getDailyCost, listScheduledTasks,
  getMemoriesByAgent,
} from './db';
import { listAgents } from './agent-config';
import { listAgentHealth } from './agent-pool';

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
    return c.json({ agents, sessions });
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
