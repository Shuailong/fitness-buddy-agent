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
