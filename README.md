# Solomon's Key

A personal AI operating system. One main orchestrator (`claude-opus-4-6`)
delegates work via `@mention` to nine specialists (`claude-sonnet-4-6`), a
5-layer Gemini-backed memory engine remembers what matters, and the whole
thing is controllable from Telegram or a localhost dashboard. A Python voice
"war room" provides full-duplex voice chat on `localhost:7860`.

## What lives where

```
src/                  TypeScript runtime
  config.ts             env, model constants, feature flags
  db.ts                 SQLite WAL, migration runner, all DB helpers
  security.ts           PIN gate, KILL_PHRASE, inbound sanitization
  exfiltration-guard.ts output redaction for outbound text
  embeddings.ts         Gemini embedding calls
  memory.ts             FTS5 + vector recall
  memory-ingest.ts      extraction pipeline + retry queue
  memory-consolidate.ts deduplication / supersession
  agent-config.ts       agent persona registry
  agent-create.ts       subprocess spawn + JSON envelope I/O
  agent-pool.ts         health state machine, restart policy
  agent.ts              one-shot agent invocation primitive
  agent-voice-bridge.ts TypeScript ↔ Python warroom WS bridge
  orchestrator.ts       @mention routing + dispatchToAgent for modules
  scraper.ts            (marketing) runs scrape jobs via @prospector
  outreach.ts           (marketing) drafts DMs via @outreach
  content-scheduler.ts  (marketing) 14-day calendars via @content-scheduler
  analyst.ts            (marketing) weekly reports via @analyst
  scheduler.ts          cron with idempotent execution log
  bot.ts                Telegram update handler
  dashboard.ts          Hono API server (port 3000)
  dashboard-html.ts     single-page UI (no build step)
  voice.ts              voice session state
  index.ts              entrypoint, wires it all together
  migrations/           numbered .sql + .rollback.sql pairs

agents/                 10 personas (system prompts + agent.yaml)
  main, comms, content, ops, research,
  prospector, outreach, content-scheduler, analyst, intelligence

warroom/                Python voice server + Cartesia voice IDs
services/               systemd unit files
assets/                 icon generator (gold skeleton key on black)
store/                  SQLite database (WAL mode, FTS5)
logs/                   runtime logs (created on first boot)
dist/                   TypeScript build output (gitignored, do not edit)
```

## Quick start

```bash
# One-time system packages:
sudo apt install -y python3-pip python3-venv libsqlite3-dev

# Node side:
npm install
npm run build

# Icon:
pip3 install --user Pillow
python3 assets/generate_icon.py

# War room venv:
cd warroom
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
deactivate
cd ..
```

Copy `.env.example` to `.env` and fill in the keys.

## Run

```bash
./start.sh          # boots orchestrator + warroom together
npm start           # orchestrator only, foreground
npm run schedule    # manage cron tasks
npm run mission     # manage async missions
npm run meet        # meeting bot (dry-run without Pika/Recall keys)
```

Open the dashboard at `http://localhost:3000/?token=<DASHBOARD_TOKEN>`.

## Marketing engine

Five marketing specialists turn the orchestrator into a multi-tenant
go-to-market machine. Each lives in `agents/<id>/` and has a thin TypeScript
execution module that dispatches briefs, parses responses, and persists
results.

| Specialist | Module | Job |
|---|---|---|
| `@prospector` | `src/scraper.ts` | Discover leads from search targets, upsert into `leads`. |
| `@outreach` | `src/outreach.ts` | Draft personalized DMs for enriched leads into `outreach_queue`. |
| `@content-scheduler` | `src/content-scheduler.ts` | Generate 14-day post calendars into `content_calendar`. |
| `@analyst` | `src/analyst.ts` | Produce weekly markdown reports from analytics + queue state. |
| `@intelligence` | (research helper) | Identify ICP, ranked scraping targets per client. |

### Marketing data model

| Table | Purpose |
|---|---|
| `clients` | Multi-tenant root: name, industry, target platform, brand voice. |
| `leads` | Per-client lead records with `status` state machine. |
| `outreach_events` | Historical outreach activity (sent / replied / converted). |
| `outreach_queue` | Pending DM drafts awaiting human approval. |
| `content_calendar` | Scheduled posts (pending / posted / failed). |
| `marketing_analytics` | Periodic snapshots of campaign metrics. |
| `scrape_jobs` | Async scrape requests with idempotency per client+platform+day. |

### Marketing API (under `/api/marketing/clients`)

All routes require `X-Dashboard-Token` (or `?token=`) auth.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/` | List all clients. |
| `POST` | `/` | Create a client. |
| `GET` | `/:id/summary` | Aggregate stats for a client. |
| `GET` | `/:id/settings` | Read client settings. |
| `POST` | `/:id/settings` | Patch client settings. |
| `GET` | `/:id/leads` | List leads (optionally filtered by `?status=`). |
| `POST` | `/:id/scrape` | Queue a scrape job (202; 409 on duplicate per day). |
| `GET` | `/:id/scrape/jobs` | List scrape jobs for this client. |
| `GET` | `/:id/outreach` | List queue rows (optionally `?status=`). |
| `POST` | `/:id/outreach/draft` | Kick off drafting for all enriched leads (202). |
| `POST` | `/:id/outreach/:qid/approve` | Approve a queued draft. |
| `POST` | `/:id/outreach/:qid/reject` | Reject (with optional note). |
| `POST` | `/:id/outreach/:qid/sent` | Mark approved draft as sent. |
| `GET` | `/:id/calendar` | List scheduled posts in a time window. |
| `POST` | `/:id/calendar/generate` | Generate a 14-day calendar (202). |
| `GET` | `/:id/report` | Generate weekly markdown report (synchronous). |

The dashboard at `localhost:3000` exposes all of the above through a
single-page UI: client picker, lead browser, scrape submission, outreach
queue with approve/reject, content calendar, and weekly report panel.

## Database

SQLite WAL mode at `store/solomons-key.db`. All schema changes go through
numbered migrations in `src/migrations/` — never inline `CREATE TABLE` in
`src/db.ts`. Current migrations:

| File | What it adds |
|---|---|
| `0001_schema_version.sql` | Initial schema (sessions, memories, missions, etc.). |
| `0002_execution_log.sql` | Idempotent cron execution tracking. |
| `0003_memory_dedup.sql` | `content_hash` + unique index for memory ingest. |
| `0004_memory_retry_queue.sql` | Async retry queue for Gemini extraction failures. |
| `0005_chat_sessions.sql` | Chat session metadata. |
| `0006_marketing_schema.sql` | Marketing tables (clients, leads, outreach, calendar, analytics). |
| `0007_scrape_queue.sql` | Async scrape job queue. |
| `0008_outreach_queue.sql` | DM drafts awaiting approval. |

Each migration ships a sibling `*.rollback.sql`. The runner records every
applied version in `schema_version` and skips on re-run.

## Ports & auth

- `3000` — dashboard. `?token=` or `X-Dashboard-Token` header required.
- `7860` — war room WebSocket (localhost only).
- Telegram: only `TELEGRAM_ALLOWED_CHAT_IDS` pass the gate.
- PIN required on first message after 30 min idle.
- `KILL_PHRASE` locks all sessions immediately.

## Models

| Role | Model |
|---|---|
| Main orchestrator | `claude-opus-4-6` |
| All specialists | `claude-sonnet-4-6` |
| Embeddings | `gemini-embedding-001` |
| Memory extraction / consolidation | `gemini-2.5-flash` |

Model identifiers live in `src/config.ts`. **Do not change them ad-hoc —
they are the contract.**

## Windows launcher

Copy `SolomonsKey.vbs` to your Desktop. Double-click boots everything
silently via WSL and opens the dashboard.

## Operational notes

- `dist/` is build output — never edit.
- `agents/<id>/agent.yaml` files are stable; do not refactor.
- See `CLAUDE.md` for the full operational spec, including absolute rules,
  the agent JSON envelope protocol, the v2 task list, and the
  TypeScript/Python conventions enforced across the repo.
