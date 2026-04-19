#!/usr/bin/env bash
# Solomon's Key — launcher.
# Starts the Node orchestrator (dashboard + Telegram bot + scheduler) and,
# if the War Room venv exists, the Python voice server. Logs go to logs/.
# Called by SolomonsKey.vbs on Windows via wsl.exe.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

mkdir -p logs

# --- Build if dist/ is missing or source is newer -----------------------------
if [[ ! -d dist ]] || [[ -n "$(find src -name '*.ts' -newer dist -print -quit 2>/dev/null || true)" ]]; then
  echo "[start] building…"
  npm run build
fi

# --- Start Node orchestrator --------------------------------------------------
if pgrep -f "node .*/dist/index.js" > /dev/null; then
  echo "[start] node orchestrator already running — skipping"
else
  echo "[start] launching node orchestrator → logs/main.log"
  nohup node "$PROJECT_ROOT/dist/index.js" \
    > "$PROJECT_ROOT/logs/main.log" 2> "$PROJECT_ROOT/logs/main.err" &
  disown
fi

# --- Start War Room (if venv present) ----------------------------------------
if [[ -x "$PROJECT_ROOT/warroom/venv/bin/python3" ]]; then
  if pgrep -f "warroom/server.py" > /dev/null; then
    echo "[start] warroom already running — skipping"
  else
    echo "[start] launching warroom (legacy mode) → logs/warroom.log"
    (
      cd "$PROJECT_ROOT/warroom"
      WARROOM_MODE=legacy nohup "$PROJECT_ROOT/warroom/venv/bin/python3" server.py \
        > "$PROJECT_ROOT/logs/warroom.log" 2> "$PROJECT_ROOT/logs/warroom.err" &
      disown
    )
  fi
else
  echo "[start] warroom venv not found — skip (run scripts/bootstrap.sh first)"
fi

echo ""
echo "Solomon's Key launched."
echo "  dashboard → http://127.0.0.1:3000  (token required)"
echo "  warroom   → ws://127.0.0.1:7860"
echo "  logs      → $PROJECT_ROOT/logs/"
