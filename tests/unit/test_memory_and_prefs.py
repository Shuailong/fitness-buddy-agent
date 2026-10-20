"""Coach Memory (cross-session facts) and cross-device coach persona sync."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.tools import memory_tools
from fitness_core import repository as repo_module
from fitness_core.memories import MAX_MEMORIES, memories_prompt, remember
from tests.unit.test_web_app import FakeAgentClient, _dev_client
from web.events import build_history
from web.form_coach import build_persona_prefix


@pytest.fixture
def memory_repo(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FITNESS_STORAGE_BACKEND", "memory")
    repo_module.get_repository.cache_clear()
    yield repo_module.get_repository()
    repo_module.get_repository.cache_clear()


def test_remember_dedupes_replaces_and_caps(memory_repo) -> None:
    uid = "u1"
    first = asyncio.run(remember(memory_repo, uid, "不吃香菜", category="nutrition"))
    assert first["status"] == "saved"
    dup = asyncio.run(remember(memory_repo, uid, " 不吃香菜。 ", category="nutrition"))
    assert dup["status"] == "duplicate"
    mid = first["memory"]["memory_id"]
    upd = asyncio.run(
        remember(memory_repo, uid, "不吃香菜和葱", replaces_memory_id=mid)
    )
    assert upd["status"] == "updated"
    assert asyncio.run(memory_repo.list_memories(uid))[0].text == "不吃香菜和葱"
    for i in range(MAX_MEMORIES - 1):
        asyncio.run(remember(memory_repo, uid, f"fact {i}"))
    full = asyncio.run(remember(memory_repo, uid, "one too many"))
    assert full["status"] == "error"
    prompt = memories_prompt(asyncio.run(memory_repo.list_memories(uid)))
    assert f"[{mid}]" in prompt and "不吃香菜和葱" in prompt


def test_memory_tools_and_prompt_injection(memory_repo) -> None:
    state: dict[str, Any] = {}
    ctx = SimpleNamespace(user_id="u2", state=state, session=SimpleNamespace(id="s"))
    saved = asyncio.run(
        memory_tools.remember_user_fact(
            "Prefers 6:30am workouts, contact me at a@b.com", "schedule", ctx
        )
    )
    assert saved["status"] == "saved"
    assert "a@b.com" not in saved["memory"]["text"]  # PII redacted

    class Req:
        def __init__(self) -> None:
            self.added: list[str] = []

        def append_instructions(self, items: list[str]) -> None:
            self.added.extend(items)

    req = Req()
    asyncio.run(memory_tools.inject_coach_memory(ctx, req))
    assert req.added and "6:30am" in req.added[0]
    forgotten = asyncio.run(
        memory_tools.forget_user_fact(saved["memory"]["memory_id"], ctx)
    )
    assert forgotten["status"] == "forgotten"
    assert asyncio.run(memory_tools.forget_user_fact("nope", ctx))["status"] == "error"


def test_memory_api_crud_export_and_delete(memory_repo) -> None:
    client, _ = _dev_client()
    assert client.get("/api/memories").json()["memories"] == []
    res = client.post(
        "/api/memories", json={"text": "Hates running", "category": "training"}
    )
    assert res.status_code == 200 and res.json()["status"] == "saved"
    mid = res.json()["memory"]["memory_id"]
    listed = client.get("/api/memories").json()
    assert [m["text"] for m in listed["memories"]] == ["Hates running"]
    assert listed["memories"][0]["source"] == "user"
    assert "user_id" not in listed["memories"][0]
    export = client.get("/api/account/export").json()
    assert "Hates running" in str(export)
    assert client.delete(f"/api/memories/{mid}").status_code == 200
    assert client.delete(f"/api/memories/{mid}").status_code == 404
    client.post("/api/memories", json={"text": "A"})
    client.post("/api/memories", json={"text": "B"})
    assert client.delete("/api/memories").json()["deleted"] == 2
    client.post("/api/memories", json={"text": "C"})
    assert (
        client.post("/api/account/delete", json={"confirm": "DELETE"}).status_code
        == 200
    )
    assert asyncio.run(memory_repo.list_memories("dev-user")) == []


def test_persona_preference_syncs_across_devices(memory_repo) -> None:
    agent = FakeAgentClient(
        turn_events=[
            {
                "author": "fitness_coach",
                "id": "e1",
                "content": {"parts": [{"text": "ok"}]},
            }
        ]
    )
    client, _ = _dev_client(agent)
    assert client.get("/api/me").json()["preferences"]["coach_persona"] is None
    saved = client.post(
        "/api/account/preferences", json={"coach_persona": "warm_maya"}
    ).json()
    assert saved["preferences"]["coach_persona"] == "warm_maya"
    # Unknown personas are ignored, the saved one stays.
    client.post("/api/account/preferences", json={"coach_persona": "evil"})
    assert client.get("/api/me").json()["preferences"]["coach_persona"] == "warm_maya"

    # A turn without an explicit persona (e.g. stale client) uses the saved one.
    client.post("/api/session", json={"new": True})
    client.post("/api/chat", data={"text": "今天练什么", "lang": "zh"})
    sent = agent.messages[-1]["parts"][0]["text"]
    assert sent.startswith(build_persona_prefix("warm_maya", "zh"))


def test_history_keeps_the_coach_who_wrote_each_reply() -> None:
    def user(text: str) -> dict[str, Any]:
        return {"author": "user", "content": {"parts": [{"text": text}]}}

    def coach(text: str, eid: str) -> dict[str, Any]:
        return {
            "author": "fitness_coach",
            "id": eid,
            "content": {"parts": [{"text": text}]},
        }

    events = [
        user(build_persona_prefix("iron_leo", "zh") + "练腿"),
        coach("冲", "a"),
        user(build_persona_prefix("warm_maya", "en") + "I'm tired"),
        coach("Take it easy", "b"),
    ]
    msgs = [m for m in build_history(events)["messages"] if m["role"] == "coach"]
    assert [m["persona"] for m in msgs] == ["iron_leo", "warm_maya"]
    users = [m for m in build_history(events)["messages"] if m["role"] == "user"]
    assert users[0]["text"] == "练腿"


def test_conversation_day_rolls_over_at_4am() -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from web.events import conversation_day

    tz = ZoneInfo("Asia/Singapore")

    def ts(h: int, day: int = 20) -> float:
        return datetime(2026, 10, day, h, 30, tzinfo=tz).timestamp()

    assert conversation_day(ts(1), "Asia/Singapore") == "2026-10-19"  # 01:30
    assert conversation_day(ts(5), "Asia/Singapore") == "2026-10-20"
    assert conversation_day(ts(23, 19), "Asia/Singapore") == "2026-10-19"
    assert conversation_day(ts(5), "Not/AZone") == "2026-10-20"  # fallback tz


def test_older_history_pages_back_one_conversation_at_a_time(memory_repo) -> None:
    import time as _time

    agent = FakeAgentClient(
        turn_events=[
            {
                "author": "fitness_coach",
                "id": "c",
                "content": {"parts": [{"text": "hi"}]},
            }
        ]
    )
    client, _ = _dev_client(agent)
    sessions = []
    for i, text in enumerate(["day one", "day two"]):
        sid = client.post("/api/session", json={"new": True}).json()["session_id"]
        client.post("/api/chat", data={"text": text})
        agent.sessions["dev-user"][sid]["lastUpdateTime"] = (
            _time.time() - (2 - i) * 86400
        )
        sessions.append(sid)
    # An empty session in between is skipped.
    empty = client.post("/api/session", json={"new": True}).json()["session_id"]
    agent.sessions["dev-user"][empty]["lastUpdateTime"] = _time.time() - 3600
    today = client.post("/api/session", json={"new": True}).json()

    first = client.get(f"/api/history/older?before={today['started_at']}").json()
    assert first["session_id"] == sessions[1]
    assert [m["text"] for m in first["messages"] if m["role"] == "user"] == ["day two"]
    assert first["has_more"] is True and first["day"]
    second = client.get(f"/api/history/older?before={first['started_at']}").json()
    assert second["session_id"] == sessions[0]
    third = client.get(f"/api/history/older?before={second['started_at']}").json()
    assert third["session_id"] is None and third["has_more"] is False
    assert client.get("/api/history/older").status_code == 422


def test_install_page_and_service_worker_are_served() -> None:
    client, _ = _dev_client()
    page = client.get("/install")
    assert page.status_code == 200
    assert "/static/js/install.js?v=" in page.text
    assert "__ASSET_VERSION__" not in page.text
    sw = client.get("/sw.js")
    assert sw.status_code == 200
    assert sw.headers["content-type"].startswith("text/javascript")
    assert sw.headers.get("service-worker-allowed") == "/"
    assert client.get("/static/img/install-qr.svg").status_code == 200


def _wav_bytes(seconds: float = 1.0) -> bytes:
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * int(16000 * seconds))
    return buf.getvalue()


def test_voice_transcribe_and_voice_chat_flag(
    memory_repo, monkeypatch: pytest.MonkeyPatch
) -> None:
    import web.main as main_mod

    async def fake_transcribe(data: bytes, mime: str, lang: str) -> str:
        assert mime == "audio/wav" and lang == "zh"
        return {"status": "ok", "text": "今天练腿 帮我安排一下"}

    monkeypatch.setattr(main_mod, "transcribe_audio", fake_transcribe)
    agent = FakeAgentClient(
        turn_events=[
            {
                "author": "fitness_coach",
                "id": "c",
                "content": {"parts": [{"text": "好"}]},
            }
        ]
    )
    client, _ = _dev_client(agent)
    res = client.post(
        "/api/transcribe",
        files={"audio": ("voice.wav", _wav_bytes(), "audio/wav")},
        data={"lang": "zh"},
    )
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "text": "今天练腿 帮我安排一下"}
    bad = client.post(
        "/api/transcribe", files={"audio": ("x.txt", b"hello world", "text/plain")}
    )
    assert bad.status_code == 415

    sid = client.post("/api/session", json={"new": True}).json()["session_id"]
    client.post(
        "/api/chat",
        data={"text": "今天练腿 帮我安排一下", "lang": "zh", "voice": "1"},
    )
    sent = agent.messages[-1]["parts"][0]["text"]
    assert "[Voice message] 今天练腿" in sent
    hist = build_history(agent.sessions["dev-user"][sid]["events"])
    user_msgs = [m for m in hist["messages"] if m["role"] == "user"]
    assert user_msgs[-1] == {
        "role": "user",
        "text": "今天练腿 帮我安排一下",
        "has_image": False,
        "voice": True,
    }


def test_voice_guards_against_hallucination() -> None:
    import asyncio as _asyncio
    import math

    from web.voice import cross_check, has_enough_speech, transcribe_audio

    # Silence never reaches the model.
    assert not has_enough_speech(_wav_bytes(2.0), "audio/wav")
    assert _asyncio.run(transcribe_audio(_wav_bytes(2.0), "audio/wav", "zh")) == {
        "status": "no_speech",
        "text": "",
    }

    # A steady tone (no syllable rhythm) is rejected too.
    import array
    import io
    import wave

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        tone = [
            int(6000 * math.sin(2 * math.pi * 220 * i / 16000)) for i in range(48000)
        ]
        w.writeframes(array.array("h", tone).tobytes())
    assert not has_enough_speech(buf.getvalue(), "audio/wav")

    same = {"status": "ok", "text": "今天练腿"}
    assert cross_check(same, {"status": "ok", "text": "今天练腿。"})["status"] == "ok"
    # Two models inventing different sentences = not clearly heard.
    assert (
        cross_check(same, {"status": "ok", "text": "下班了"})["status"] == "no_speech"
    )
    assert (
        cross_check(same, {"status": "no_speech", "text": ""})["status"] == "no_speech"
    )
    close = cross_check(
        {"status": "ok", "text": "今天中午吃了牛肉面"},
        {"status": "ok", "text": "今天中午吃了牛肉"},
    )
    assert close["status"] in ("ok", "partial") and close["text"]
