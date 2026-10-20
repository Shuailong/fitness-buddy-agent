"""Voice messages: server-side speech-to-text with Gemini.

The browser records short clips (16 kHz mono WAV) and posts them here. The
transcript then goes through the normal chat pipeline as text, so every voice
message still passes Model Armor, the health-policy judge, PII redaction and
memory - none of which inspect raw audio.
"""

from __future__ import annotations

import asyncio
import logging
import re

from web.observability import log_event

_TRANSCRIBE_MODELS = ("gemini-3.8-flash", "gemini-2.5-flash")
TRANSCRIBE_TIMEOUT_S = 25.0
MAX_AUDIO_BYTES = 4 * 1024 * 1024  # ~2 minutes of 16 kHz mono WAV
ALLOWED_AUDIO_TYPES = {
    "audio/wav",
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/aac",
    "audio/mpeg",
}
VOICE_MARKER = "[Voice message] "

_PROMPT = (
    "Transcribe this voice message verbatim. It is a user talking to their AI fitness coach. "
    "Keep the original language ({lang_hint}); for Chinese use Simplified Chinese characters. "
    "Add natural punctuation. Output ONLY the transcript - no quotes, labels or commentary. "
    "If there is no intelligible speech, output exactly: <<NO_SPEECH>>"
)


def sniff_audio(data: bytes) -> str | None:
    """Returns the audio MIME type from magic bytes, or None."""
    head = data[:16]
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "audio/webm"
    if head[:4] == b"OggS":
        return "audio/ogg"
    if head[4:8] == b"ftyp":
        return "audio/mp4"
    if head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3"):
        return "audio/mpeg"
    return None


def _clean(text: str) -> str:
    text = (text or "").strip().strip('"“”')
    if "<<NO_SPEECH>>" in text:
        return ""
    return re.sub(r"\s+", " ", text)[:2000]


def _transcribe_sync(data: bytes, mime: str, lang: str) -> str:
    from google import genai
    from google.genai import types

    from web.form_coach import _gemini_project_candidates

    lang_hint = (
        "most likely Chinese" if str(lang).startswith("zh") else "most likely English"
    )
    last_exc: Exception | None = None
    for project in _gemini_project_candidates():
        client = genai.Client(vertexai=True, project=project, location="global")
        for model in _TRANSCRIBE_MODELS:
            try:
                resp = client.models.generate_content(
                    model=model,
                    contents=[
                        types.Part.from_bytes(data=data, mime_type=mime),
                        _PROMPT.format(lang_hint=lang_hint),
                    ],
                    config=types.GenerateContentConfig(
                        temperature=0.0, max_output_tokens=1024
                    ),
                )
                return _clean(resp.text or "")
            except Exception as exc:  # try the next model / project
                last_exc = exc
    raise RuntimeError("transcription failed") from last_exc


async def transcribe_audio(data: bytes, mime: str, lang: str) -> str:
    """Transcribes a short voice clip; returns '' when no speech was detected."""
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_transcribe_sync, data, mime, lang), TRANSCRIBE_TIMEOUT_S
        )
    except Exception as exc:
        log_event(
            "transcribe_failed", severity=logging.WARNING, error=type(exc).__name__
        )
        raise


def strip_voice_marker(text: str) -> tuple[str, bool]:
    """Splits the server-added voice marker off a stored user message."""
    if text.startswith(VOICE_MARKER):
        return text[len(VOICE_MARKER) :], True
    return text, False
