# Solomon's Key

Personal AI Operating System — WSL2-native, 5 specialist agents, voice War Room,
Telegram control plane, web dashboard on localhost:3000.

**Status:** Phase 0 scaffold. Later phases populate `src/`, `agents/`, `warroom/`.

## Entry points (post-build)

- `npm start` — boots main orchestrator (Telegram + scheduler + dashboard).
- `./start.sh` — Phase 14 launcher: starts Node service + War Room Python server.
- `SolomonsKey.vbs` — one-click Windows launcher (copied to Desktop).

## Ports

- `3000` — dashboard (localhost only).
- `7860` — War Room WebSocket (localhost only).
