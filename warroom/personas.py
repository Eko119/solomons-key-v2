"""
Solomon's Key — War Room personas.

One persona per agent. Voice IDs are Cartesia voice_ids (hex-like strings from
the Cartesia voice library). Replace the REPLACE_ME placeholders with the
user's chosen voices before running in full mode.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Persona:
    agent_id: str
    display_name: str
    voice_id: str
    provider: str   # "cartesia" | "elevenlabs"
    style: str      # brief tone description for TTS prosody hints


PERSONAS: dict[str, Persona] = {
    "main": Persona(
        agent_id="main",
        display_name="Solomon",
        voice_id="REPLACE_ME_MAIN_VOICE_ID",
        provider="cartesia",
        style="calm, measured, low authority",
    ),
    "comms": Persona(
        agent_id="comms",
        display_name="Mercury",
        voice_id="REPLACE_ME_COMMS_VOICE_ID",
        provider="cartesia",
        style="warm, quick, conversational",
    ),
    "content": Persona(
        agent_id="content",
        display_name="Scribe",
        voice_id="REPLACE_ME_CONTENT_VOICE_ID",
        provider="cartesia",
        style="thoughtful, literary, unhurried",
    ),
    "ops": Persona(
        agent_id="ops",
        display_name="Forge",
        voice_id="REPLACE_ME_OPS_VOICE_ID",
        provider="cartesia",
        style="terse, clipped, engineer",
    ),
    "research": Persona(
        agent_id="research",
        display_name="Archive",
        voice_id="REPLACE_ME_RESEARCH_VOICE_ID",
        provider="cartesia",
        style="precise, neutral, analyst",
    ),
}


def get_persona(agent_id: str) -> Persona:
    if agent_id not in PERSONAS:
        raise KeyError(f"unknown persona: {agent_id}")
    return PERSONAS[agent_id]


def has_real_voice(agent_id: str) -> bool:
    p = PERSONAS.get(agent_id)
    if not p:
        return False
    return not p.voice_id.startswith("REPLACE_ME")


def all_configured() -> bool:
    return all(not p.voice_id.startswith("REPLACE_ME") for p in PERSONAS.values())
