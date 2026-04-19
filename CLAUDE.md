# Solomon's Key — v2 CLAUDE.md
# Claude Code Operational Spec — READ BEFORE TOUCHING ANY FILE

## Identity
Solomon's Key is a personal AI operating system. Main orchestrator runs
`claude-opus-4-6`. Four specialist agents run `claude-sonnet-4-6`.
Memory engine: `gemini-embedding-001` (embeddings) + `gemini-2.5-flash`
(extraction and consolidation). Database: SQLite WAL mode at
`store/solomons-key.db`. Voice: Python warroom on port 7860. Control:
Telegram. Dashboard: port 3000.

## Absolute Rules — Never Violate

1. **Do not run `claude --dangerously-skip-permissions` yourself.** The
   orchestrator spawns agent subprocesses. You are not one of them.

2. **Do not write to `store/solomons-key.db` directly.** All DB access goes
   through `src/db.ts`. If you need a new table or column, write a migration
   in `src/migrations/` (see DB Migration Rule below).

3. **Do not modify `dist/`.** It is build output. Run `npm run build` and
   let it regenerate.

4. **Do not change model strings.** `claude-opus-4-6`, `claude-sonnet-4-6`,
   `gemini-embedding-001`, `gemini-2.5-flash` are locked. If a caller
   needs to change them, they change `src/config.ts` constants only.

5. **Do not delete or rename existing exports** from any `src/*.ts` file
   without first checking all import sites and updating them atomically.

6. **One module per task.** If a task touches more than one file in `src/`,
   complete and verify the first file before moving to the second.

7. **TypeScript strict mode is on.** Every function must have explicit return
   types. No `any`. No `as unknown as X` casts. If a type is genuinely
   unknown, use a Zod schema and parse it.

8. **Test before marking done.** For every change: run `npm run build`
   (must exit 0) and run the relevant test command listed in the task spec.

---

## Architecture Map

```
src/config.ts              — env vars, model constants, feature flags
src/db.ts                  — SQLite connection, schema helpers, migration runner
src/security.ts            — KILL_PHRASE, PIN auth, session state
src/exfiltration-guard.ts  — output sanitization, leak patterns
src/embeddings.ts          — Gemini embedding calls
src/memory.ts              — memory read/write, FTS5 search
src/memory-ingest.ts       — extraction pipeline entry point
src/memory-consolidate.ts  — consolidation scheduler
src/agent-config.ts        — AgentConfig type, agent persona definitions
src/agent-create.ts        — spawns one agent subprocess
src/agent-pool.ts          — manages all 5 agent subprocesses
src/agent-voice-bridge.ts  — TypeScript ↔ Python warroom bridge
src/orchestrator.ts        — routes messages to agents, manages missions
src/bot.ts                 — Telegram update handler
src/scheduler.ts           — cron manager
src/dashboard.ts           — Express server, auth middleware
src/dashboard-html.ts      — dashboard HTML template
src/voice.ts               — voice session state
src/meet-cli.ts            — meeting bot CLI
src/mission-cli.ts         — mission management CLI
src/schedule-cli.ts        — cron CLI
src/index.ts               — entry point, wires everything up

agents/main/               — main orchestrator persona + agent.yaml
agents/comms/              — communications specialist
agents/content/            — content creation specialist
agents/ops/                — operations specialist
agents/research/           — research specialist

warroom/server.py          — Python WebSocket voice server
warroom/personas.py        — voice persona definitions

src/migrations/            — (v2: numbered migration SQL files)
```

---

## DB Migration Rule

When you need a schema change:

1. Create `src/migrations/NNNN_description.sql` where NNNN is the next
   integer (zero-padded to 4 digits, e.g. `0001_add_execution_log.sql`).

2. The SQL must be idempotent (`CREATE TABLE IF NOT EXISTS`,
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, etc).

3. Add a corresponding rollback file: `src/migrations/NNNN_description.rollback.sql`.

4. `src/db.ts` must apply all unapplied migrations on startup, ordered by
   filename, and record each in the `schema_version` table:

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  filename   TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
);
```

5. Never inline schema changes in `src/db.ts` after the migration system
   is in place (v2 task DB-1).

---

## Agent I/O Protocol (v2)

All orchestrator ↔ agent communication uses JSON envelopes on stdin/stdout.

**Request envelope** (orchestrator → agent stdin):

```typescript
interface AgentRequest {
  id:            string;  // UUID, echoed in response
  type:          "task" | "checkpoint" | "shutdown";
  payload:       string;  // the actual prompt / instruction
  contextBudget: number;  // max tokens agent should use before checkpointing
  timestamp:     number;  // Unix ms
}
```

**Response envelope** (agent stdout → orchestrator):

```typescript
interface AgentResponse {
  id:          string;   // matches request id
  type:        "result" | "checkpoint" | "error" | "done";
  payload:     string;   // text output
  tokenCount?: number;   // agent's self-reported token usage
  timestamp:   number;
}
```

The sentinel `[AGENT_DONE]` is replaced by `type: "done"`. Orchestrator
validates the envelope with Zod before processing. Any stdout line that
fails Zod parse is logged as a warning and discarded — it does NOT crash
the orchestrator.

---

## V2 Task List (Ordered — Do Not Reorder)

Complete each task fully before starting the next. Each task has an ID,
files to touch, and a verification command.

---

### DB-1: Migration System

**Goal:** Introduce `schema_version` table and migration runner.

**Files:** `src/db.ts`, `src/migrations/` (create directory),
`src/migrations/0001_schema_version.sql`

**Rules:**
- Migration runner reads all `*.sql` files in `src/migrations/` ordered
  lexicographically.
- Skips migrations already in `schema_version`.
- Wraps each migration in a transaction; rolls back and throws on error.
- Move all existing `CREATE TABLE` statements from `src/db.ts` into
  `src/migrations/0001_schema_version.sql` exactly as they are now (no
  changes to existing schema in this step).

**Verify:** `npm run build && node -e "require('./dist/db.js')"`
Must exit 0 and print no errors. Run twice — second run must also exit 0
(idempotency check).

---

### DB-2: Execution Log Table

**Goal:** Add scheduler execution tracking.

**Files:** `src/migrations/0002_execution_log.sql`, `src/scheduler.ts`

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS execution_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id          TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL UNIQUE,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  status          TEXT    NOT NULL CHECK(status IN ('running','completed','failed')),
  error           TEXT
);
```

**Rules:**
- Before running any scheduled job, insert a row with `status='running'`
  and `idempotency_key = job_id + ':' + ISO_date_string`.
- On success: update `status='completed'`, set `completed_at`.
- On error: update `status='failed'`, set `error` to the message.
- If an `idempotency_key` already exists with `status='completed'`, skip
  execution and log a debug message.

**Verify:** `npm run build`. Then manually trigger a scheduled job via
`npm run schedule` and confirm the `execution_log` row is written.

---

### AGENT-1: Typed Agent I/O

**Goal:** Replace `[AGENT_DONE]` sentinel with JSON envelope protocol.

**Files:** `src/agent-create.ts`, `src/agent-pool.ts`, `src/orchestrator.ts`

**Rules:**
- Add `AgentRequest` and `AgentResponse` Zod schemas to `src/agent-config.ts`.
- `src/agent-create.ts` writes requests as `JSON.stringify(req) + '\n'` to
  agent stdin. It reads stdout line by line; each line is parsed with the
  Zod schema. Lines that fail parse are logged as warnings, not thrown.
- The timeout is still 120s, but now resets on each valid response line
  (the agent is alive as long as it keeps talking).
- `src/orchestrator.ts` must log the full envelope at debug level and the
  payload only at info level when forwarding to Telegram.

**Verify:** `npm run build`. Send a test task to one agent via
`npm run mission`. Confirm JSON envelopes appear in `logs/main.log`.

---

### AGENT-2: Agent Health State Machine

**Goal:** Track per-agent health; quarantine faulted agents.

**Files:** `src/agent-pool.ts`

**States:** `idle | busy | faulted | restarting`

**Rules:**
- An agent transitions `idle → busy` when given a task.
- `busy → idle` on `type: "done"` response.
- `busy → faulted` on timeout, process crash (non-zero exit), or
  `type: "error"` response.
- `faulted → restarting` after 5s delay; orchestrator spawns a new process.
- `restarting → idle` when the new process is ready.
- Max 3 restart attempts before an agent stays `faulted` and alerts via
  Telegram.
- Dashboard endpoint `GET /api/agents` must return current state of all 5
  agents including state, last task, and last error.

**Verify:** `npm run build`. Kill one agent process manually (find its PID).
Within 5s it must restart. `GET /api/agents` must reflect the transition.

---

### MEM-1: Memory Ingestion Dedup

**Goal:** Prevent duplicate memories from repeated extraction calls.

**Files:** `src/memory-ingest.ts`, `src/migrations/0003_memory_dedup.sql`,
`src/migrations/0004_memory_retry_queue.sql`

**Schema additions (`0003`):**

```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_content_hash
  ON memories(content_hash)
  WHERE content_hash IS NOT NULL;
```

**Schema additions (`0004`):**

```sql
CREATE TABLE IF NOT EXISTS memory_retry_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_text     TEXT    NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_error   TEXT
);
```

**Rules:**
- Before inserting a memory, compute `SHA256(content)` as hex string.
- If a row with that hash exists, skip insertion and log at debug level.
- On failure of the Gemini extraction call, insert the raw text into
  `memory_retry_queue` with `attempts=0`, `next_retry_at=now+60s`.
- A background loop in `src/memory-ingest.ts` polls the retry queue every
  60s and retries up to 3 times with exponential backoff (60s, 300s, 900s).

**Verify:** `npm run build`. Call the memory ingest function twice with
identical content. Confirm the second call logs "duplicate skipped" and
does not insert a second row.

---

### SEC-1: Input Sanitization Gate

**Goal:** Screen inbound Telegram messages for prompt injection before they
reach the orchestrator.

**Files:** `src/security.ts`, `src/bot.ts`

**Rules:**
- Add `sanitizeInbound(text: string): { safe: boolean; reason?: string }`
  to `src/security.ts`.
- Patterns that mark input as unsafe (case-insensitive):
  - `ignore (all |previous |above |prior )?(instructions|rules|constraints)`
  - `you are now` followed by anything
  - `<\|im_(start|end)\|>` (tokenizer injection)
  - `\[INST\]` or `\[/INST\]` (Llama-style injection)
  - `system:` at the start of a line
- If `sanitizeInbound` returns `{ safe: false }`, the bot replies with the
  fixed string `"Message rejected."`, logs the rejection with the reason,
  and does NOT forward to the orchestrator.
- Do not log the rejected message content itself (privacy).

**Verify:** `npm run build`. Unit test: call `sanitizeInbound` with each
pattern above and assert `safe === false`. Call with a normal message and
assert `safe === true`.

---

### SEC-2: Output Sanitization Before DB Write

**Goal:** Run exfiltration guard on agent output before it is stored.

**Files:** `src/exfiltration-guard.ts`, `src/orchestrator.ts`

**Rules:**
- `src/exfiltration-guard.ts` must export
  `sanitizeOutput(text: string): string` that redacts patterns matching
  the existing leak patterns (API keys, tokens, file paths outside the
  project root, etc.).
- In `src/orchestrator.ts`, every agent response that is written to the DB
  or sent via Telegram must pass through `sanitizeOutput` first.
- Redaction replaces matched content with `[REDACTED]`.
- Log redaction events at warn level (without logging the original value).

**Verify:** `npm run build`. Pass a string containing a fake API key pattern
(e.g. `sk-ant-api03-FAKE`) through `sanitizeOutput`. Assert the output
contains `[REDACTED]` and not the original string.

---

### BRIDGE-1: Warroom Health Check

**Goal:** Degrade gracefully when the Python warroom is unreachable.

**Files:** `src/agent-voice-bridge.ts`

**Rules:**
- On startup, attempt WebSocket connection to `ws://localhost:7860`.
- If connection fails, set `warroom_available = false` and log a warning.
  Do NOT throw or crash.
- Poll with a reconnect attempt every 30s while `warroom_available === false`.
- `GET /api/status` on the dashboard must include `warroom: "up" | "down"`.
- Voice-dependent features (TTS responses) must check `warroom_available`
  before attempting and return a text fallback if down.

**Verify:** `npm run build`. Start `npm start` WITHOUT starting the warroom.
Confirm the system boots, `GET /api/status` shows `warroom: "down"`, and
sending a Telegram message still gets a text response.

---

### AGENT-3: Context Budget Enforcement

**Goal:** Prevent agent context windows from silently overflowing.

**Files:** `src/agent-create.ts`, `src/agent-pool.ts`

**Rules:**
- Each `AgentRequest` carries `contextBudget` (default: 150000 tokens for
  Sonnet 4.6, configurable in `src/config.ts`).
- If an agent reports `tokenCount` in its response and the running total
  exceeds 80% of `contextBudget`, the orchestrator sends a
  `type: "checkpoint"` request:
  `payload: "Summarize your progress so far in under 500 words, then stop."`
- After receiving the checkpoint summary, the agent process is gracefully
  shut down (`type: "shutdown"` request), a new process is spawned, and
  the checkpoint summary is included in the new process's first request
  payload as context.
- This prevents invisible context overflow without interrupting the
  logical task.

**Verify:** `npm run build`. Manually lower `contextBudget` to 1000 in
config during testing, send a long task, confirm a checkpoint event appears
in `logs/main.log`.

---

## Conventions

### TypeScript
- All async functions return `Promise<T>` explicitly.
- Errors are typed: `class SolomonError extends Error { code: string }`.
- No bare `catch(e)` — always `catch(e: unknown)` with type narrowing.
- `zod` is the validation library. All external data (API responses, agent
  stdout, Telegram updates) is validated with a Zod schema before use.

### Python (warroom/)
- Type hints on all functions.
- No bare `except:` — always `except ExceptionType as e:`.
- `asyncio` only; no synchronous blocking calls in the event loop.

### Logging
- Use the existing logger in `src/index.ts` (do not introduce a new one).
- Log levels: `debug` for noisy internals, `info` for lifecycle events,
  `warn` for degraded-but-continuing states, `error` for faults.
- Never log secrets, API keys, tokens, or user message content at `info`
  or above.

### Git Hygiene
- One commit per completed task (e.g. `feat(db): migration runner [DB-1]`).
- Commit only after `npm run build` exits 0.

---

## What NOT to Change in v2

- `agents/*/agent.yaml` persona files — stable, do not touch.
- `warroom/personas.py` — stable.
- `SolomonsKey.vbs` — Windows launcher, do not touch.
- `services/` systemd unit files — do not modify service definitions.
- The Telegram auth gate in `src/security.ts` (PIN + KILL_PHRASE) —
  do not refactor, only add to it (SEC-1).
- Port numbers: `3000` (dashboard), `7860` (warroom) — hardcoded in
  systemd units, do not change.

---

## Session Start Checklist

Before writing any code, confirm:

1. `npm run build` currently exits 0 (baseline is clean).
2. `git status` is clean or you know what's in flight.
3. You know which task ID you are working on.
4. You have read the task's **Files** list and **Verify** command.

When done with a task, run its Verify command. If it fails, fix it before
committing or moving on.
