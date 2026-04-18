"""
Solomon's Key — War Room WebSocket server.

Modes:
  legacy  — minimal: accepts WS connections on :7860, echoes JSON messages,
            no live TTS/STT. Used for smoke tests.
  full    — Pipecat-based full voice pipeline with Cartesia TTS +
            Deepgram STT (requires API keys + voice IDs + pipecat-ai
            uncommented in requirements.txt).

Env:
  WARROOM_MODE=legacy|full   (default: legacy)
  WARROOM_PORT=7860
  CARTESIA_API_KEY, DEEPGRAM_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY
"""

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from websockets.server import serve

HERE = Path(__file__).resolve().parent
load_dotenv(HERE.parent / ".env")
sys.path.insert(0, str(HERE))

from personas import PERSONAS, all_configured, get_persona  # noqa: E402

MODE = os.environ.get("WARROOM_MODE", "legacy").lower()
PORT = int(os.environ.get("WARROOM_PORT", "7860"))
HOST = os.environ.get("WARROOM_HOST", "127.0.0.1")

logging.basicConfig(level=logging.INFO, format="[warroom %(levelname)s] %(message)s")
log = logging.getLogger("warroom")


async def legacy_handler(websocket):
    """Echo handler: accepts JSON {type, agent_id, text}, replies with
    {type:'ack', persona:<display_name>, text:<text>}."""
    peer = getattr(websocket, "remote_address", "?")
    log.info("legacy connect: %s", peer)
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send(json.dumps({"type": "error", "error": "invalid json"}))
                continue
            agent_id = msg.get("agent_id", "main")
            text = msg.get("text", "")
            try:
                persona = get_persona(agent_id)
            except KeyError:
                await websocket.send(json.dumps({"type": "error", "error": f"unknown agent {agent_id}"}))
                continue
            await websocket.send(json.dumps({
                "type": "ack",
                "persona": persona.display_name,
                "agent_id": agent_id,
                "text": text,
                "voice_configured": not persona.voice_id.startswith("REPLACE_ME"),
            }))
    except Exception as e:
        log.warning("legacy handler error: %s", e)
    finally:
        log.info("legacy disconnect: %s", peer)


async def run_legacy():
    log.info("starting legacy mode on %s:%d — personas: %s",
             HOST, PORT, ", ".join(PERSONAS.keys()))
    if not all_configured():
        log.warning("voice IDs not all configured — full mode will fail until REPLACE_ME values are replaced")
    async with serve(legacy_handler, HOST, PORT):
        await asyncio.Future()


async def run_full():
    # Full Pipecat pipeline would be constructed here. For now, we refuse to
    # start unless voice IDs are configured and pipecat-ai is importable.
    if not all_configured():
        log.error("full mode requires all persona voice IDs — edit warroom/personas.py")
        sys.exit(2)
    try:
        import pipecat  # noqa: F401
    except ImportError:
        log.error("pipecat-ai not installed — uncomment it in requirements.txt and re-run pip install")
        sys.exit(2)
    log.error("full-mode pipeline is not yet wired — set WARROOM_MODE=legacy for now")
    sys.exit(2)


def main():
    if MODE == "legacy":
        asyncio.run(run_legacy())
    elif MODE == "full":
        asyncio.run(run_full())
    else:
        log.error("unknown WARROOM_MODE=%s (expected 'legacy' or 'full')", MODE)
        sys.exit(1)


if __name__ == "__main__":
    main()
