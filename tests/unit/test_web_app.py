# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     https://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Unit tests for the web app (no network, no LLM: a fake agent client)."""

from __future__ import annotations

import asyncio
import copy
import json
import re
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, date, datetime, timedelta
from typing import Any, ClassVar

import pytest
from fastapi.testclient import TestClient

from fitness_core import repository as repo_module
from fitness_core.models import (
    WEEKDAYS,
    BodyMeasurement,
    EnergyTargets,
    FitnessProfile,
    MealEntry,
    MealItem,
    PlannedExercise,
    PlannedSession,
    TrainingPlan,
    WorkoutSession,
    WorkoutSet,
)
from fitness_core.nutrition import daily_nutrition_summary, sum_meal_items
from fitness_core.progress import user_local_date
from fitness_core.trends import weight_trend
from web.config import GREETING_TEXT, GREETING_TEXTS, WebSettings, normalize_lang
from web.dashboard import logging_streak
from web.events import build_history, simplify_event
from web.main import create_app
from web.ratelimit import Limit, MemoryCounterStore, RateLimiter

CONFIRM_ID = "adk-confirm-1"


# --------------------------------------------------------------------- fakes
def _confirmation_event(
    call_id: str = CONFIRM_ID, author: str = "workout_planner"
) -> dict[str, Any]:
    return {
        "author": author,
        "content": {
            "role": "model",
            "parts": [
                {
                    "functionCall": {
                        "id": call_id,
                        "name": "adk_request_confirmation",
                        "args": {
                            "originalFunctionCall": {
                                "id": "fc-9",
                                "name": "save_weekly_training_plan",
                                "args": {},
                            },
                            "toolConfirmation": {
                                "hint": "Replace your current plan?",
                                "confirmed": False,
                                "payload": {
                                    "kind": "replace_training_plan",
                                    "title": "Replace your current plan?",
                                    "summary": "3 sessions, dumbbells only, max 45 min.",
                                    "details": {
                                        "sessions": 3,
                                        "days": ["monday", "wednesday", "friday"],
                                    },
                                },
                            },
                        },
                    }
                }
            ],
        },
        "longRunningToolIds": [call_id],
    }


RECORDED_TURN: list[dict[str, Any]] = [
    {
        "author": "fitness_coach",
        "content": {
            "role": "model",
            "parts": [
                {"text": "Let me think about the plan.", "thought": True},
                {
                    "functionCall": {
                        "id": "fc-1",
                        "name": "workout_planner",
                        "args": {"request": "plan"},
                    }
                },
            ],
        },
    },
    {
        "author": "workout_planner",
        "content": {
            "role": "model",
            "parts": [
                {
                    "functionCall": {
                        "id": "fc-2",
                        "name": "search_exercise_library",
                        "args": {},
                    }
                },
            ],
        },
    },
    {
        "author": "workout_planner",
        "content": {
            "role": "user",
            "parts": [
                {
                    "functionResponse": {
                        "id": "fc-2",
                        "name": "search_exercise_library",
                        "response": {"status": "ok"},
                    }
                },
            ],
        },
    },
    # A repeated call is collapsed into one activity chip.
    {
        "author": "workout_planner",
        "content": {
            "role": "model",
            "parts": [
                {
                    "functionCall": {
                        "id": "fc-3",
                        "name": "search_exercise_library",
                        "args": {},
                    }
                },
            ],
        },
    },
    # Internal helper output is never shown to the user.
    {
        "author": "plan_critic",
        "content": {"role": "model", "parts": [{"text": '{"grade": "pass"}'}]},
    },
    {
        "author": "workout_planner",
        "content": {
            "role": "model",
            "parts": [{"text": '{"title": "raw structured output"}'}],
        },
    },
    {
        "author": "workout_planner",
        "content": {
            "role": "model",
            "parts": [
                {"text": "Here is your **3-day** plan."},
            ],
        },
    },
    _confirmation_event(),
]


class FakeAgentClient:
    """In-memory stand-in for the ADK / Agent Runtime backends."""

    def __init__(self, turn_events: list[dict[str, Any]] | None = None) -> None:
        self.sessions: dict[str, dict[str, dict[str, Any]]] = {}
        self.turn_events = turn_events if turn_events is not None else RECORDED_TURN
        self.messages: list[dict[str, Any]] = []

    async def create_session(self, user_id: str) -> dict[str, Any]:
        sid = uuid.uuid4().hex
        session = {
            "id": sid,
            "userId": user_id,
            "appName": "app",
            "events": [],
            "lastUpdateTime": time.time(),
        }
        self.sessions.setdefault(user_id, {})[sid] = session
        return copy.deepcopy(session)

    async def list_sessions(self, user_id: str) -> list[dict[str, Any]]:
        return [
            {k: v for k, v in s.items() if k != "events"}
            for s in self.sessions.get(user_id, {}).values()
        ]

    async def get_session(self, user_id: str, session_id: str) -> dict[str, Any] | None:
        session = self.sessions.get(user_id, {}).get(session_id)
        return copy.deepcopy(session) if session else None

    async def stream_query(
        self, user_id: str, session_id: str, message: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        session = self.sessions[user_id][session_id]
        self.messages.append(message)
        session["events"].append({"author": "user", "content": message})
        for event in self.turn_events:
            await asyncio.sleep(0)
            session["events"].append(event)
            yield event
        session["lastUpdateTime"] = time.time()

    async def delete_session(self, user_id: str, session_id: str) -> None:
        self.sessions.get(user_id, {}).pop(session_id, None)

    memories: ClassVar[dict[str, list[dict[str, Any]]]] = {}

    async def list_user_memories(self, user_id: str) -> list[dict[str, Any]]:
        return list(self.memories.get(user_id, []))

    async def delete_user_memories(self, user_id: str) -> int:
        return len(self.memories.pop(user_id, []))


def _settings(**overrides: Any) -> WebSettings:
    base = {
        "google_client_id": "test-client-id",
        "allowed_emails": frozenset({"coach.user@example.com"}),
        "session_secret": "unit-test-secret",
        "dev_auth_bypass_requested": False,
        "is_cloud_run": False,
    }
    base.update(overrides)
    return WebSettings(**base)


def _client(
    settings: WebSettings | None = None, agent: FakeAgentClient | None = None
) -> tuple[TestClient, FakeAgentClient]:
    agent = agent or FakeAgentClient()
    app = create_app(
        settings or _settings(),
        agent_client=agent,
        rate_limiter=RateLimiter(MemoryCounterStore()),
    )
    return TestClient(app), agent


def _dev_client(
    agent: FakeAgentClient | None = None,
) -> tuple[TestClient, FakeAgentClient]:
    return _client(_settings(dev_auth_bypass_requested=True), agent)


def _parse_sse(body: str) -> list[dict[str, Any]]:
    return [
        json.loads(line[5:]) for line in body.splitlines() if line.startswith("data:")
    ]


# ---------------------------------------------------------------------- auth
def test_api_requires_auth() -> None:
    client, _ = _client()
    assert client.get("/api/config").status_code == 200
    assert client.get("/api/me").status_code == 401
    assert client.post("/api/session").status_code == 401
    assert client.get("/api/history").status_code == 401
    assert client.get("/api/dashboard").status_code == 401
    assert client.post("/api/chat", data={"text": "hi"}).status_code == 401
    assert (
        client.post(
            "/api/confirm", json={"call_id": "x", "confirmed": True}
        ).status_code
        == 401
    )


def test_tampered_cookie_is_rejected() -> None:
    client, _ = _client()
    client.cookies.set("fb_session", "eyJzdWIiOiJhdHRhY2tlciJ9.bad-signature")
    assert client.get("/api/me").status_code == 401


def test_google_sign_in_enforces_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    from google.oauth2 import id_token

    claims: dict[str, Any] = {
        "sub": "1234567890",
        "email": "Coach.User@example.com",
        "email_verified": True,
        "given_name": "Coach",
        "picture": "https://lh3.googleusercontent.com/a/avatar",
    }

    def fake_verify(token: str, request: Any, audience: str) -> dict[str, Any]:
        assert audience == "test-client-id"
        if token == "invalid-token-value":
            raise ValueError("bad token")
        return dict(claims)

    monkeypatch.setattr(id_token, "verify_oauth2_token", fake_verify)
    client, agent = _client()

    resp = client.post("/auth/google", json={"credential": "valid-token-value"})
    assert resp.status_code == 200
    assert "httponly" in resp.headers["set-cookie"].lower()
    assert "samesite=lax" in resp.headers["set-cookie"].lower()
    me = client.get("/api/me").json()
    assert me["email"] == "coach.user@example.com"
    assert me["given_name"] == "Coach"
    assert me["picture"] == "https://lh3.googleusercontent.com/a/avatar"
    # The agent user_id is the Google `sub`.
    client.post("/api/session")
    assert list(agent.sessions) == ["1234567890"]

    client.post("/auth/logout")
    assert client.get("/api/me").status_code == 401

    claims["email"] = "stranger@example.com"
    assert (
        client.post(
            "/auth/google", json={"credential": "valid-token-value"}
        ).status_code
        == 403
    )
    claims.update(email="coach.user@example.com", email_verified=False)
    assert (
        client.post(
            "/auth/google", json={"credential": "valid-token-value"}
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/auth/google", json={"credential": "invalid-token-value"}
        ).status_code
        == 401
    )
    assert client.get("/api/me").status_code == 401


def test_dev_bypass_disabled_on_cloud_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEV_AUTH_BYPASS", "true")
    monkeypatch.setenv("SESSION_SECRET", "unit-test-secret")
    monkeypatch.delenv("K_SERVICE", raising=False)
    local = WebSettings.from_env()
    assert local.dev_auth_bypass
    client, _ = _client(local)
    assert client.get("/api/me").status_code == 200

    monkeypatch.setenv("K_SERVICE", "fitness-buddy-web")
    cloud = WebSettings.from_env()
    assert not cloud.dev_auth_bypass
    client, _ = _client(cloud)
    assert client.get("/api/me").status_code == 401


def test_production_requires_session_secret() -> None:
    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        create_app(
            _settings(is_cloud_run=True, session_secret=""),
            agent_client=FakeAgentClient(),
        )


# ------------------------------------------------------------------ sessions
def test_session_reuse_and_new() -> None:
    client, _ = _dev_client()
    first = client.post("/api/session").json()
    assert first["is_new"] is True
    client.post("/api/chat", data={"text": GREETING_TEXT})
    again = client.post("/api/session").json()
    assert again == {"session_id": first["session_id"], "is_new": False}
    fresh = client.post("/api/session", json={"new": True}).json()
    assert fresh["is_new"] is True and fresh["session_id"] != first["session_id"]


def test_idle_session_is_replaced() -> None:
    client, agent = _dev_client(
        FakeAgentClient(
            turn_events=[
                {
                    "author": "fitness_coach",
                    "content": {"role": "model", "parts": [{"text": "Welcome!"}]},
                },
            ]
        )
    )
    first = client.post("/api/session").json()
    client.post("/api/chat", data={"text": "hello"})
    agent.sessions["dev-user"][first["session_id"]]["lastUpdateTime"] = (
        time.time() - 7 * 3600
    )
    second = client.post("/api/session").json()
    assert second["is_new"] is True and second["session_id"] != first["session_id"]


# ---------------------------------------------------------------------- chat
def test_chat_streams_simplified_events() -> None:
    client, agent = _dev_client()
    client.post("/api/session")
    resp = client.post("/api/chat", data={"text": "Make me a plan for this week."})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(resp.text)
    assert [e["type"] for e in events] == [
        "activity",
        "activity",
        "text",
        "confirmation",
        "done",
    ]
    assert events[0]["label"] == "Asking the workout planner..."
    assert events[2] == {
        "type": "text",
        "author": "workout_planner",
        "text": "Here is your **3-day** plan.",
        "event_id": None,
    }
    assert events[3] == {
        "type": "confirmation",
        "call_id": CONFIRM_ID,
        "kind": "replace_training_plan",
        "title": "Replace your current plan?",
        "summary": "3 sessions, dumbbells only, max 45 min.",
        "details": {"sessions": 3, "days": ["monday", "wednesday", "friday"]},
        "event_id": None,
    }
    assert not any(
        "Let me think" in json.dumps(e) for e in events
    )  # thoughts are hidden
    assert agent.messages[-1] == {
        "role": "user",
        "parts": [{"text": "Make me a plan for this week."}],
    }


def test_chat_requires_session_and_validates_input() -> None:
    client, _ = _dev_client()
    assert client.post("/api/chat", data={"text": "hi"}).status_code == 409
    client.post("/api/session")
    assert client.post("/api/chat", data={"text": "  "}).status_code == 400
    bad = client.post(
        "/api/chat",
        data={"text": "x"},
        files={"image": ("a.gif", b"GIF89a....", "image/gif")},
    )
    assert bad.status_code == 415
    big = client.post(
        "/api/chat",
        files={
            "image": ("a.jpg", b"\xff\xd8\xff" + b"0" * (6 * 1024 * 1024), "image/jpeg")
        },
    )
    assert big.status_code == 413


def test_chat_sends_photo_as_inline_data() -> None:
    client, agent = _dev_client(FakeAgentClient(turn_events=[]))
    client.post("/api/session")
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    resp = client.post(
        "/api/chat",
        data={"text": "Lunch"},
        files={"image": ("lunch.png", png, "image/png")},
    )
    assert _parse_sse(resp.text)[-1] == {"type": "done"}
    parts = agent.messages[-1]["parts"]
    assert parts[0] == {"text": "Lunch"}
    assert parts[1]["inlineData"]["mimeType"] == "image/png"


def test_agent_error_becomes_error_event() -> None:
    class BrokenAgent(FakeAgentClient):
        async def stream_query(self, user_id, session_id, message):  # type: ignore[override]
            raise RuntimeError("backend exploded with secret details")
            yield {}  # pragma: no cover

    client, _ = _dev_client(BrokenAgent())
    client.post("/api/session")
    events = _parse_sse(client.post("/api/chat", data={"text": "hi"}).text)
    assert [e["type"] for e in events] == ["error", "done"]
    assert "secret" not in events[0]["message"]


def test_simplify_event_accepts_snake_case_and_errors() -> None:
    event = {
        "author": "fitness_coach",
        "content": {
            "parts": [
                {
                    "function_call": {
                        "id": "c1",
                        "name": "log_workout_session",
                        "args": {},
                    }
                },
                {"text": "Logged!"},
            ]
        },
    }
    assert simplify_event(event) == [
        {"type": "activity", "label": "Logging your workout..."},
        {
            "type": "text",
            "author": "fitness_coach",
            "text": "Logged!",
            "event_id": None,
        },
    ]
    assert (
        simplify_event(
            {
                "author": "fitness_coach",
                "partial": True,
                "content": {"parts": [{"text": "Lo"}]},
            }
        )
        == []
    )
    assert (
        simplify_event({"author": "fitness_coach", "error_code": "SAFETY"})[0]["type"]
        == "error"
    )
    assert (
        simplify_event(
            {
                "author": "fitness_coach",
                "content": {
                    "parts": [{"functionCall": {"name": "finish_task", "args": {}}}]
                },
            }
        )
        == []
    )


# ------------------------------------------------------------ confirmations
def test_history_detects_pending_confirmation() -> None:
    events = [
        {
            "author": "user",
            "content": {"role": "user", "parts": [{"text": GREETING_TEXT}]},
        },
        {"author": "fitness_coach", "content": {"parts": [{"text": "Welcome back!"}]}},
        {
            "author": "user",
            "content": {"role": "user", "parts": [{"text": "New plan please"}]},
        },
        *RECORDED_TURN,
    ]
    history = build_history(events)
    assert [m["role"] for m in history["messages"]] == [
        "coach",
        "user",
        "coach",
    ]  # greeting hidden
    assert [p["call_id"] for p in history["pending_confirmations"]] == [CONFIRM_ID]

    answered = [
        *events,
        {
            "author": "user",
            "content": {
                "role": "user",
                "parts": [
                    {
                        "functionResponse": {
                            "id": CONFIRM_ID,
                            "name": "adk_request_confirmation",
                            "response": {"confirmed": False},
                        }
                    }
                ],
            },
        },
    ]
    history = build_history(answered)
    assert history["pending_confirmations"] == []
    assert history["messages"][-1] == {
        "role": "decision",
        "confirmed": False,
        "title": "Replace your current plan?",
        "kind": "replace_training_plan",
        "replaces": None,
    }


def test_ui_language_localizes_activity_labels_and_hides_greetings() -> None:
    call_event = {
        "author": "fitness_coach",
        "content": {
            "parts": [
                {"functionCall": {"id": "a1", "name": "nutrition_coach", "args": {}}},
                {"functionCall": {"id": "a2", "name": "some_new_tool", "args": {}}},
            ]
        },
    }
    assert [e["label"] for e in simplify_event(call_event)] == [
        "Asking the nutrition coach...",
        "Running some new tool...",
    ]
    assert [e["label"] for e in simplify_event(call_event, "zh")] == [
        "正在询问营养教练...",
        "处理中...",
    ]
    assert normalize_lang("zh-CN") == "zh"
    assert normalize_lang("fr") == "en"
    assert normalize_lang(None) == "en"

    # Hidden greetings in either language never show up in history.
    events = [
        {"author": "user", "content": {"role": "user", "parts": [{"text": t}]}}
        for t in GREETING_TEXTS.values()
    ]
    assert build_history(events)["messages"] == []

    # The chat endpoint forwards the UI language to the label localizer.
    client, _ = _dev_client()
    client.post("/api/session")
    body = client.post("/api/chat", data={"text": "Plan please", "lang": "zh"}).text
    labels = [e["label"] for e in _parse_sse(body) if e["type"] == "activity"]
    assert labels and all(not label.startswith("Asking") for label in labels)
    assert (
        client.get("/api/config").json()["greeting_texts"]["zh"] == GREETING_TEXTS["zh"]
    )


def test_history_and_confirm_endpoints() -> None:
    client, agent = _dev_client()
    client.post("/api/session")
    client.post("/api/chat", data={"text": "Make me a plan"})
    history = client.get("/api/history").json()
    assert [p["call_id"] for p in history["pending_confirmations"]] == [CONFIRM_ID]
    assert history["messages"][0] == {
        "role": "user",
        "text": "Make me a plan",
        "has_image": False,
    }

    assert (
        client.post(
            "/api/confirm", json={"call_id": "unknown", "confirmed": True}
        ).status_code
        == 409
    )

    agent.turn_events = [
        {
            "author": "workout_planner",
            "content": {"parts": [{"text": "Saved your plan."}]},
        }
    ]
    resp = client.post("/api/confirm", json={"call_id": CONFIRM_ID, "confirmed": True})
    assert _parse_sse(resp.text) == [
        {
            "type": "text",
            "author": "workout_planner",
            "text": "Saved your plan.",
            "event_id": None,
        },
        {"type": "done"},
    ]
    assert agent.messages[-1] == {
        "role": "user",
        "parts": [
            {
                "functionResponse": {
                    "id": CONFIRM_ID,
                    "name": "adk_request_confirmation",
                    "response": {"confirmed": True},
                }
            }
        ],
    }
    assert client.get("/api/history").json()["pending_confirmations"] == []
    # A decision cannot be submitted twice.
    assert (
        client.post(
            "/api/confirm", json={"call_id": CONFIRM_ID, "confirmed": False}
        ).status_code
        == 409
    )


# ----------------------------------------------------------------- dashboard
@pytest.fixture
def memory_repo(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FITNESS_STORAGE_BACKEND", "memory")
    repo_module.get_repository.cache_clear()
    yield repo_module.get_repository()
    repo_module.get_repository.cache_clear()


def _meal(user_id: str, day: str, kcal: float, protein: float) -> MealEntry:
    items = [
        MealItem(
            name="meal",
            portion_grams=400,
            calories_kcal=kcal,
            protein_g=protein,
            carbs_g=50,
            fat_g=20,
        )
    ]
    return MealEntry(
        entry_id=uuid.uuid4().hex[:20],
        user_id=user_id,
        local_date=day,
        logged_at=datetime.now(UTC),
        meal_type="lunch",
        items=items,
        totals=sum_meal_items(items),
    )


def test_dashboard_numbers_come_from_fitness_core(memory_repo) -> None:
    uid = "dev-user"
    today = user_local_date("UTC")
    iso = lambda days_ago: (today - timedelta(days=days_ago)).isoformat()  # noqa: E731
    targets = EnergyTargets(
        bmr_kcal=1762.5,
        activity_factor=1.375,
        tdee_kcal=2423.4,
        daily_calories_kcal=1950,
        protein_g=150,
        carbs_g=190,
        fat_g=65,
        calorie_floor_kcal=1500,
        max_daily_deficit_kcal=900,
        clamped=False,
    )
    profile = FitnessProfile(
        user_id=uid,
        goal="fat_loss",
        sex="male",
        age=35,
        height_cm=178,
        starting_weight_kg=82,
        training_days_per_week=3,
        minutes_per_session=45,
        equipment=["dumbbells"],
        timezone="UTC",
        targets=targets,
    )
    plan = TrainingPlan(
        title="3-day dumbbell",
        goal="fat_loss",
        sessions=[
            PlannedSession(
                day_of_week=d,
                focus="Full body",
                estimated_minutes=40,
                exercises=[
                    PlannedExercise(
                        exercise_id="goblet_squat", name="Goblet squat", sets=3, reps=12
                    )
                ],
            )
            for d in ("monday", "wednesday", "friday")
        ],
    )
    measurements = [
        BodyMeasurement(
            entry_id=f"m{i}",
            user_id=uid,
            local_date=iso(i),
            measured_at=datetime.now(UTC) - timedelta(days=i),
            weight_kg=82 - (10 - i) * 0.1,
        )
        for i in range(10, -1, -2)
    ]
    meals = [
        _meal(uid, iso(0), 900, 80),
        _meal(uid, iso(0), 800, 75),
        _meal(uid, iso(1), 1500, 90),
        _meal(uid, iso(20), 3000, 200),
    ]
    workouts = [
        WorkoutSession(
            entry_id=f"w{i}",
            user_id=uid,
            local_date=iso(i),
            performed_at=datetime.now(UTC),
            exercises=[
                WorkoutSet(exercise_name="Goblet squat", sets=3, reps=12, weight_kg=16)
            ],
        )
        for i in (0, 2, 9)
    ]

    async def seed() -> None:
        await memory_repo.save_profile(profile)
        await memory_repo.save_current_plan(uid, plan)
        for m in measurements:
            await memory_repo.add_entry(uid, "measurement", m)
        for meal in meals:
            await memory_repo.add_entry(uid, "meal", meal)
        for w in workouts:
            await memory_repo.add_entry(uid, "workout", w)

    asyncio.run(seed())
    client, _ = _dev_client()
    data = client.get("/api/dashboard").json()

    assert data["has_profile"] is True
    assert data["targets"]["daily_calories_kcal"] == 1950
    expected_today = daily_nutrition_summary(iso(0), meals, targets)
    assert (
        data["nutrition"]["today"]["consumed"]["calories_kcal"]
        == expected_today.consumed.calories_kcal
        == 1700
    )
    assert (
        data["nutrition"]["today"]["remaining_protein_g"]
        == expected_today.remaining_protein_g
        == -5
    )
    assert len(data["nutrition"]["days"]) == 14
    assert data["nutrition"]["days"][-1]["local_date"] == iso(0)
    assert (
        data["nutrition"]["protein_hit_days"] == 1
    )  # 155 g today; 90 g yesterday; day -20 out of range
    assert data["nutrition"]["days_logged"] == 2
    expected_trend = weight_trend(measurements, starting_weight_kg=82)
    assert (
        data["weight"]["latest_moving_average_kg"]
        == expected_trend.latest_moving_average_kg
    )
    assert len(data["weight"]["points"]) == len(expected_trend.points) == 6
    assert data["week"]["planned_sessions"] == 3
    assert data["week"]["completed_sessions"] == 2  # day -9 is outside the 7-day window
    assert data["week"]["protein_target_hit_days"] == 1
    assert [s["day_of_week"] for s in data["plan"]["sessions"]] == [
        "monday",
        "wednesday",
        "friday",
    ]
    # Today page data.
    assert data["range_days"] == 30
    assert len(data["nutrition"]["meals_today"]) == 2
    assert data["nutrition"]["meals_today"][0]["totals"]["calories_kcal"] == 900
    assert data["nutrition"]["logging_streak_days"] == 2  # today + yesterday
    assert [w["sessions"] for w in data["week"]["history"]] == [0, 0, 1, 2]
    assert data["weekday"] == WEEKDAYS[today.weekday()]
    if data["weekday"] in ("monday", "wednesday", "friday"):
        assert data["today_session"]["focus"] == "Full body"
    else:
        assert data["today_session"] is None
    assert data["today_session_done"] is True  # workout logged today
    assert data["latest_review"] is None

    # Range selector: 2W keeps only weigh-ins from the last 14 days; bad values
    # fall back to the default 1M window.
    short = client.get("/api/dashboard?range=14").json()
    assert short["range_days"] == 14
    assert all(p["local_date"] >= iso(13) for p in short["weight"]["points"])
    assert len(short["nutrition"]["days"]) == 14
    assert client.get("/api/dashboard?range=7").json()["range_days"] == 30


def test_logging_streak_counts_back_from_yesterday() -> None:
    today = date(2026, 10, 16)
    logged = {"2026-10-15", "2026-10-14", "2026-10-12"}
    assert logging_streak(logged, today) == 2
    assert logging_streak(logged | {"2026-10-16"}, today) == 3
    assert logging_streak({"2026-10-13"}, today) == 0


def test_meal_log_result_becomes_card_in_stream_and_history() -> None:
    response = {
        "status": "logged",
        "entry_id": "e1",
        "meal_type": "lunch",
        "items": [
            {
                "name": "Beef noodle soup",
                "portion_grams": 650,
                "calories_kcal": 850,
                "protein_g": 48,
                "carbs_g": 92,
                "fat_g": 30,
                "confidence": "medium",
            }
        ],
        "meal_totals": {
            "calories_kcal": 850,
            "protein_g": 48,
            "carbs_g": 92,
            "fat_g": 30,
        },
        "daily_summary": {
            "consumed": {
                "calories_kcal": 1170,
                "protein_g": 74,
                "carbs_g": 150,
                "fat_g": 40,
            },
            "target_calories_kcal": 2300,
            "target_protein_g": 150,
            "remaining_calories_kcal": 1130,
            "remaining_protein_g": 76,
        },
    }
    event = {
        "author": "nutrition_coach",
        "content": {
            "role": "user",
            "parts": [
                {
                    "function_response": {
                        "id": "c1",
                        "name": "log_meal_entry",
                        "response": response,
                    }
                }
            ],
        },
    }
    [card] = simplify_event(event)
    assert card["type"] == "card" and card["kind"] == "meal_logged"
    assert card["totals"]["calories_kcal"] == 850
    assert card["items"][0]["name"] == "Beef noodle soup"
    assert card["day"]["remaining_protein_g"] == 76

    # Failed / guided-error results never become cards.
    failed = copy.deepcopy(event)
    failed["content"]["parts"][0]["function_response"]["response"] = {
        "status": "error",
        "error": "The meal date is in the future.",
    }
    assert simplify_event(failed) == []

    history = build_history([event])
    assert history["messages"] == [{"role": "card", **card}]


def test_dashboard_without_profile(memory_repo) -> None:
    client, _ = _dev_client()
    assert client.get("/api/dashboard").json() == {"has_profile": False}


def test_static_index_served_with_security_headers() -> None:
    client, _ = _client()
    resp = client.get("/")
    assert resp.status_code == 200 and "Fitness Buddy" in resp.text
    assert "accounts.google.com/gsi/client" in resp.headers["content-security-policy"]
    assert client.get("/static/app.js").status_code == 200
    # Cache busting: asset URLs carry a content hash and static files always
    # revalidate, so a deploy never mixes new HTML with stale cached JS/CSS.
    assert "__ASSET_VERSION__" not in resp.text
    assert re.search(r'/static/app\.js\?v=[0-9a-f]{12}"', resp.text)
    assert resp.headers["cache-control"] == "no-cache"
    assert client.get("/static/styles.css").headers["cache-control"] == "no-cache"


# ------------------------------------------------------------ beta operations
def test_rate_limit_returns_429_with_retry_after() -> None:
    agent = FakeAgentClient()
    limiter = RateLimiter(
        MemoryCounterStore(),
        {
            "messages_per_minute": Limit("messages_per_minute", 2, 60),
            "messages_per_day": Limit("messages_per_day", 100, 86400),
            "photos_per_day": Limit("photos_per_day", 1, 86400),
            "feedback": Limit("feedback", 30, 3600),
        },
    )
    client = TestClient(
        create_app(
            _settings(dev_auth_bypass_requested=True),
            agent_client=agent,
            rate_limiter=limiter,
        )
    )
    client.post("/api/session")
    # The hidden greeting never counts against the limits.
    assert client.post("/api/chat", data={"text": GREETING_TEXT}).status_code == 200
    assert client.post("/api/chat", data={"text": "one"}).status_code == 200
    assert client.post("/api/chat", data={"text": "two"}).status_code == 200
    resp = client.post("/api/chat", data={"text": "three"})
    assert resp.status_code == 429
    body = resp.json()
    assert body["code"] == "rate_limited" and body["scope"] == "messages_per_minute"
    assert 1 <= body["retry_after"] <= 61
    assert resp.headers["Retry-After"] == str(body["retry_after"])
    assert len(agent.messages) == 3  # the limited message never reached the agent


def test_rate_limiter_windows_reset_and_fail_open() -> None:
    limits = {"messages_per_minute": Limit("messages_per_minute", 1, 60)}
    limiter = RateLimiter(MemoryCounterStore(), limits)
    run = asyncio.run
    assert run(limiter.hit("u", ["messages_per_minute"], now=120.0)).allowed
    denied = run(limiter.hit("u", ["messages_per_minute"], now=150.0))
    assert not denied.allowed and denied.retry_after == 31
    assert run(
        limiter.hit("u", ["messages_per_minute"], now=181.0)
    ).allowed  # next window
    assert run(limiter.hit("other", ["messages_per_minute"], now=150.0)).allowed

    class BrokenStore:
        async def increment(self, key, expire_at):
            raise RuntimeError("firestore down")

    assert run(
        RateLimiter(BrokenStore(), limits).hit("u", ["messages_per_minute"])
    ).allowed


def test_feedback_is_stored_redacted_and_validated(memory_repo) -> None:
    client, _ = _dev_client()
    client.post("/api/session")
    resp = client.post(
        "/api/feedback",
        json={
            "kind": "message",
            "rating": "down",
            "tags": ["wrong_numbers"],
            "comment": "Calories look off, email me at someone@example.com",
            "event_id": "evt-1",
            "page": "coach",
            "lang": "zh-CN",
        },
    )
    assert resp.status_code == 204
    [record] = memory_repo.feedback
    assert record["rating"] == "down" and record["tags"] == ["wrong_numbers"]
    assert record["event_id"] == "evt-1" and record["lang"] == "zh"
    assert "someone@example.com" not in record["comment"]
    assert record["user"] != "dev-user"  # pseudonymous
    assert record["session_id"]
    # General feedback needs a comment or a category.
    assert client.post("/api/feedback", json={"kind": "general"}).status_code == 422
    assert client.post("/api/feedback", json={"kind": "bogus"}).status_code == 422
    assert (
        client.post(
            "/api/feedback", json={"kind": "general", "tags": ["idea"]}
        ).status_code
        == 204
    )


def test_telemetry_accepts_known_events_only() -> None:
    client, _ = _dev_client()
    assert (
        client.post(
            "/api/telemetry", json={"name": "tab_view", "props": {"tab": "progress"}}
        ).status_code
        == 204
    )
    assert client.post("/api/telemetry", json={"name": "made_up"}).status_code == 204
    assert (
        client.post(
            "/api/telemetry", json={"name": "tab_view", "props": {"nested": {"x": 1}}}
        ).status_code
        == 422
    )
    assert (
        TestClient(create_app(_settings()))
        .post("/api/telemetry", json={"name": "tab_view"})
        .status_code
        == 401
    )


def test_account_export_and_delete(memory_repo) -> None:
    uid = "dev-user"
    asyncio.run(memory_repo.add_entry(uid, "meal", _meal(uid, "2026-10-16", 600, 40)))
    asyncio.run(
        memory_repo.add_entry(
            "someone-else", "meal", _meal("someone-else", "2026-10-16", 700, 30)
        )
    )
    agent = FakeAgentClient()
    agent.memories = {
        uid: [{"fact": "Allergic to shrimp."}],
        "someone-else": [{"fact": "x"}],
    }
    client, _ = _dev_client(agent)
    client.post("/api/session")
    client.post("/api/chat", data={"text": "hello"})

    export = client.get("/api/account/export")
    assert export.status_code == 200
    assert "attachment" in export.headers["content-disposition"]
    payload = export.json()
    assert len(payload["data"]["meal_logs"]) == 1
    assert payload["coach_memories"] == [{"fact": "Allergic to shrimp."}]
    assert payload["conversations"] and payload["conversations"][0]["messages"]

    assert (
        client.post("/api/account/delete", json={"confirm": "yes"}).status_code == 422
    )
    resp = client.post("/api/account/delete", json={"confirm": "DELETE"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["deleted"] is True and body["documents"] == 1
    assert body["conversations"] == 1 and body["memories"] == 1
    assert "incomplete" not in body
    # Only this user's data is gone.
    assert asyncio.run(memory_repo.list_meals(uid)) == []
    assert len(asyncio.run(memory_repo.list_meals("someone-else"))) == 1
    assert agent.memories == {"someone-else": [{"fact": "x"}]}
    assert agent.sessions.get(uid) == {}


def test_privacy_page_is_served() -> None:
    client, _ = _client()
    resp = client.get("/privacy")
    assert resp.status_code == 200 and "Privacy" in resp.text
    assert "__ASSET_VERSION__" not in resp.text


def test_pwa_manifest_and_icons_are_served() -> None:
    client, _ = _client()
    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200
    assert manifest.headers["content-type"].startswith("application/manifest+json")
    icons = manifest.json()["icons"]
    for icon in icons:
        assert client.get(icon["src"]).status_code == 200
    assert any(i.get("purpose") == "maskable" for i in icons)
    touch = client.get("/apple-touch-icon.png")
    assert touch.status_code == 200 and touch.headers["content-type"] == "image/png"
    index = client.get("/").text
    assert 'rel="apple-touch-icon"' in index and 'rel="manifest"' in index


def test_repository_sort_key_handles_weekly_reviews() -> None:
    """Regression: Firestore listing sorted weekly reviews by a missing local_date."""
    from fitness_core.models import WeeklyReviewRecord
    from fitness_core.repository import _sort_key

    review = WeeklyReviewRecord(
        entry_id="r1",
        user_id="u",
        week_start="2026-10-05",
        week_end="2026-10-11",
        created_at=datetime.now(UTC),
        summary="ok",
    )
    meal = _meal("u", "2026-10-16", 500, 30)
    assert _sort_key(review) == "2026-10-05"
    assert _sort_key(meal) == "2026-10-16"
