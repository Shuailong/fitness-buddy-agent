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
    "You are a strict speech-to-text engine for a user talking to their AI fitness coach.\n"
    "Rules:\n"
    "1. Write ONLY words you clearly hear. Never guess, complete, paraphrase, summarize, "
    "translate or 'fix' what was said. Keep filler words if spoken.\n"
    "2. Keep the original language ({lang_hint}); for Chinese use Simplified characters. "
    "Add punctuation only.\n"
    "3. If a word or phrase is unclear, write the character … in its place and set status "
    "to 'partial'. Do not substitute a plausible word.\n"
    "4. If there is no intelligible human speech (silence, noise, music, breathing, "
    "background chatter, or you are unsure what was said), set status to 'no_speech' and "
    "transcript to ''. Never output generic phrases that were not spoken.\n"
    "5. status 'ok' only when every word is clearly intelligible.\n"
    "6. Set is_user_speaking=false for music, singing, lyrics, TV/video audio, tones, "
    "or anything that is not one person talking directly to the phone; then status must "
    "be 'no_speech'."
)

_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "is_user_speaking": {"type": "BOOLEAN"},
        "status": {"type": "STRING", "enum": ["ok", "partial", "no_speech"]},
        "transcript": {"type": "STRING"},
    },
    "required": ["is_user_speaking", "status", "transcript"],
}

# Speech-activity gate (runs before the model): silence and noise are where
# speech-to-text models hallucinate most, so we never send them.
_FRAME_S = 0.03
_MIN_VOICED_S = 0.35


def speech_activity(data: bytes) -> dict[str, float] | None:
    """Estimates voiced seconds in a 16-bit PCM WAV (None for other formats)."""
    import array
    import io
    import math
    import wave

    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            if w.getsampwidth() != 2:
                return None
            rate, channels = w.getframerate(), w.getnchannels()
            pcm = array.array("h", w.readframes(w.getnframes()))
    except (wave.Error, EOFError):
        return None
    if channels > 1:
        pcm = pcm[::channels]
    duration = len(pcm) / rate if rate else 0.0
    frame = max(1, int(rate * _FRAME_S))
    energies = []
    for i in range(0, len(pcm) - frame + 1, frame):
        chunk = pcm[i : i + frame]
        energies.append(
            math.sqrt(sum(x * x for x in chunk[::2]) / max(1, len(chunk[::2])))
        )
    if not energies:
        return {
            "duration": duration,
            "voiced_s": 0.0,
            "peak": 0.0,
            "syllable_rate": 0.0,
        }
    noise = sorted(energies)[len(energies) // 10]  # 10th percentile = noise floor
    threshold = max(500.0, noise * 2.0)  # +6 dB over the noise floor, ~-36 dBFS min
    voiced = sum(1 for e in energies if e > threshold)
    peaks, low = 0, energies[0]
    for i in range(1, len(energies) - 1):
        low = min(low, energies[i])
        e = energies[i]
        if (
            e > threshold
            and e >= energies[i - 1]
            and e >= energies[i + 1]
            and e > low * 1.8 + 1
        ):
            peaks, low = peaks + 1, e
    return {
        "duration": duration,
        "voiced_s": voiced * _FRAME_S,
        "peak": max(energies),
        "syllable_rate": peaks / max(voiced * _FRAME_S, 0.01),
    }


def has_enough_speech(data: bytes, mime: str) -> bool:
    if mime != "audio/wav":
        return True
    stats = speech_activity(data)
    if stats is None:
        return True
    # Speech has syllable rhythm (~2-6 energy peaks/s); steady tones or hum do not.
    return stats["voiced_s"] >= _MIN_VOICED_S and stats["syllable_rate"] >= 1.0


def _parse(raw: str) -> dict[str, str]:
    import json

    try:
        obj = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {"status": "no_speech", "text": ""}
    status = (
        obj.get("status")
        if obj.get("status") in ("ok", "partial", "no_speech")
        else "no_speech"
    )
    if obj.get("is_user_speaking") is False:
        status = "no_speech"
    text = (
        re.sub(r"\s+", " ", str(obj.get("transcript") or ""))
        .strip()
        .strip('"“”')[:2000]
    )
    if status == "no_speech" or not text or not re.search(r"\w", text):
        return {"status": "no_speech", "text": ""}
    if "…" in text or "..." in text:
        status = "partial"
    return {"status": status, "text": text}


def _transcribe_with(model: str, data: bytes, mime: str, lang: str) -> dict[str, str]:
    from google import genai
    from google.genai import types

    from web.form_coach import _gemini_project_candidates

    lang_hint = (
        "most likely Chinese" if str(lang).startswith("zh") else "most likely English"
    )
    last_exc: Exception | None = None
    for project in _gemini_project_candidates():
        try:
            client = genai.Client(vertexai=True, project=project, location="global")
            resp = client.models.generate_content(
                model=model,
                contents=[
                    types.Part.from_bytes(data=data, mime_type=mime),
                    _PROMPT.format(lang_hint=lang_hint),
                ],
                config=types.GenerateContentConfig(
                    temperature=0.0,
                    max_output_tokens=1024,
                    response_mime_type="application/json",
                    response_schema=_SCHEMA,
                ),
            )
            return _parse(resp.text or "")
        except Exception as exc:  # next project
            last_exc = exc
    raise RuntimeError(f"transcription failed ({model})") from last_exc


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", "", text).lower()


def agreement(a: str, b: str) -> float:
    """Character-level similarity of two transcripts (0..1), ignoring punctuation."""
    import difflib

    na, nb = _norm(a), _norm(b)
    if not na and not nb:
        return 1.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


def cross_check(primary: dict[str, str], second: dict[str, str]) -> dict[str, str]:
    """Combines two independent transcriptions; disagreement means 'not clearly heard'.

    Hallucinated text (from music, noise, unclear audio) is model-specific and
    rarely matches between models, while real speech is transcribed nearly
    identically.
    """
    if primary["status"] == "no_speech" or second["status"] == "no_speech":
        # If either model heard no speech, be conservative and say so.
        return {"status": "no_speech", "text": ""}
    score = agreement(primary["text"], second["text"])
    if score >= 0.8:
        status = (
            "partial" if "partial" in (primary["status"], second["status"]) else "ok"
        )
        return {"status": status, "text": primary["text"]}
    if score >= 0.5:
        return {"status": "partial", "text": primary["text"]}
    return {"status": "no_speech", "text": ""}


def _transcribe_sync(data: bytes, mime: str, lang: str) -> dict[str, str]:
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(_transcribe_with, m, data, mime, lang)
            for m in _TRANSCRIBE_MODELS
        ]
        results = []
        for f in futures:
            try:
                results.append(f.result())
            except Exception as exc:  # one model down: fall back to the other
                results.append(exc)
    ok = [r for r in results if isinstance(r, dict)]
    if not ok:
        raise RuntimeError("transcription failed") from results[0]
    if len(ok) == 1:
        # No second opinion available: never auto-send, ask the user to confirm.
        only = ok[0]
        return (
            {"status": "partial", "text": only["text"]}
            if only["status"] != "no_speech"
            else only
        )
    return cross_check(ok[0], ok[1])


async def transcribe_audio(data: bytes, mime: str, lang: str) -> dict[str, str]:
    """Transcribes a voice clip -> {"status": ok|partial|no_speech, "text": str}."""
    if not has_enough_speech(data, mime):
        return {"status": "no_speech", "text": ""}
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_transcribe_sync, data, mime, lang), TRANSCRIBE_TIMEOUT_S
        )
    except Exception as exc:
        log_event(
            "transcribe_failed", severity=logging.WARNING, error=type(exc).__name__
        )
        raise


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


def strip_voice_marker(text: str) -> tuple[str, bool]:
    """Splits the server-added voice marker off a stored user message."""
    if text.startswith(VOICE_MARKER):
        return text[len(VOICE_MARKER) :], True
    return text, False
