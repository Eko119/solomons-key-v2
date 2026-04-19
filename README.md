# Solomon's Key

Personal AI Operating System — WSL2-native. One main orchestrator (Opus)
with four specialist agents (Sonnet) delegated via `@mentions`, a 5-layer
Gemini-backed memory engine, Telegram control plane, web dashboard on
`localhost:3000`, and a Python voice War Room on `localhost:7860`.

## Layout

```
src/            TypeScript: config, db, security, agents, orchestrator,
                bot, scheduler, dashboard, voice, meet, index
agents/         5 personas (main, comms, content, ops, research)
warroom/        Python voice server + personas + Cartesia voice IDs
services/       systemd unit files (main + warroom + per-agent generator)
assets/         icon generator (256x256 gold skeleton key on black)
store/          SQLite database (10 tables, FTS5, WAL mode)
logs/           runtime logs (created on first boot)
dist/           TypeScript build output
```

## First-time install

```bash
# One-time system packages (sudo required once):
sudo apt install -y python3-pip python3-venv libsqlite3-dev

# Node side (already done during build):
npm install
npm run build

# Icon:
pip3 install --user Pillow
python3 assets/generate_icon.py

# War Room venv:
cd warroom
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
deactivate
cd ..
```

## Run

```bash
./start.sh          # boots orchestrator + warroom; opens nothing
npm start           # run orchestrator in the foreground (no warroom)
npm run schedule    # manage cron tasks
npm run mission     # manage async missions
npm run meet        # meeting bot (dry-run without Pika/Recall keys)
```

## Windows launcher

Copy `SolomonsKey.vbs` to your Desktop. Double-click to boot everything
silently via WSL and open the dashboard.

## Ports & auth

- `3000` — dashboard. Requires `?token=<DASHBOARD_TOKEN>` or
  `X-Dashboard-Token` header.
- `7860` — War Room WebSocket (localhost only).
- Telegram bot: only `TELEGRAM_ALLOWED_CHAT_IDS` pass the auth gate.
- PIN required on first message after idle (>30 min by default);
  `KILL_PHRASE` locks all sessions immediately.

## Models

Main = `claude-opus-4-6`. Specialists = `claude-sonnet-4-6`.
Memory = `gemini-embedding-001` + `gemini-2.5-flash` for
extraction/consolidation.

## Override from spec

- All identifiers renamed from ClaudeClaw → Solomon's Key.
- Redis skipped (unused by spec).
- Cloudflare tunnel skipped — localhost only.
- Agent bridge uses 5 `claude --dangerously-skip-permissions` subprocesses
  with `[AGENT_DONE]` sentinel + 120 s timeout + 3 s stagger, rather than
  a programmatic SDK (Claude Code 2.1.x ships CLI-only).
- Dashboard bound to port `3000` (spec default was 3141).
