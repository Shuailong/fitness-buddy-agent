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

"""Web Push reminders: subscription API, due-time logic and the hourly dispatcher."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from fitness_core import repository as repo_module
from fitness_core.models import (
    WEEKDAYS,
    FitnessProfile,
    MealEntry,
    MealItem,
    PlannedExercise,
    PlannedSession,
    TrainingPlan,
)
from fitness_core.nutrition import sum_meal_items
from web import push
from web.config import WebSettings
from web.main import create_app
from web.ratelimit import MemoryCounterStore, RateLimiter

UID = "dev-user"
SUB = {
    "endpoint": "https://fcm.googleapis.com/fcm/send/abc123",
    "keys": {"p256dh": "BPk" + "x" * 80, "auth": "authsecret123"},
}


@pytest.fixture
def repo(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FITNESS_STORAGE_BACKEND", "memory")
    repo_module.get_repository.cache_clear()
    r = repo_module.get_repository()
    yield r
    repo_module.get_repository.cache_clear()


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch):
    calls: list[dict] = []

    def fake_send(config, sub, payload):
        calls.append({"endpoint": sub["endpoint"], **payload})
        return 410 if "gone" in sub["endpoint"] else 201

    monkeypatch.setattr(push, "_send_sync", fake_send)
    return calls


def _client() -> TestClient:
    from tests.unit.test_web_app import FakeAgentClient

    app = create_app(
        WebSettings(
            google_client_id="x",
            session_secret="s",
            dev_auth_bypass_requested=True,
            is_cloud_run=False,
        ),
        agent_client=FakeAgentClient(),
        rate_limiter=RateLimiter(MemoryCounterStore()),
    )
    app.state.push = push.PushConfig(
        "PUBLICKEY", "PRIVATEKEY", "mailto:t@example.com", "tok"
    )
    return TestClient(app)


async def _seed(r, *, tz: str = "Asia/Shanghai", train_on=None) -> None:
    await r.save_profile(
        FitnessProfile(
            user_id=UID,
            goal="fat_loss",
            sex="male",
            age=30,
            height_cm=175,
            starting_weight_kg=75,
            training_days_per_week=3,
            minutes_per_session=45,
            equipment=["dumbbells"],
            timezone=tz,
        )
    )
    if not train_on:
        return
    await r.save_current_plan(
        UID,
        TrainingPlan(
            title="Plan",
            goal="fat_loss",
            sessions=[
                PlannedSession(
                    day_of_week=day,
                    focus="Legs",
                    estimated_minutes=40,
                    exercises=[
                        PlannedExercise(
                            exercise_id="goblet_squat", name="Goblet", sets=3, reps=10
                        )
                    ],
                )
                for day in (train_on or [])
            ],
        ),
    )


def test_subscribe_status_prefs_unsubscribe(repo) -> None:
    client = _client()
    assert client.get("/api/push/config").json() == {
        "enabled": True,
        "public_key": "PUBLICKEY",
    }
    res = client.post(
        "/api/push/subscribe",
        json={"subscription": SUB, "lang": "zh", "timezone": "Asia/Shanghai"},
    )
    assert res.status_code == 200 and res.json()["prefs"] == {
        "training": True,
        "meals": True,
    }
    assert (
        client.post("/api/push/status", json={"endpoint": SUB["endpoint"]}).json()[
            "subscribed"
        ]
        is True
    )
    prefs = client.post(
        "/api/push/prefs", json={"endpoint": SUB["endpoint"], "prefs": {"meals": False}}
    ).json()
    assert prefs["prefs"] == {"training": True, "meals": False}
    stored = asyncio.run(push.get_subscription(repo, SUB["endpoint"]))
    assert stored["user_id"] == UID and stored["lang"] == "zh"
    client.post("/api/push/unsubscribe", json={"endpoint": SUB["endpoint"]})
    assert client.post(
        "/api/push/status", json={"endpoint": SUB["endpoint"]}
    ).json() == {"subscribed": False}
    # Endpoints must be https push services.
    bad = {"subscription": {**SUB, "endpoint": "http://evil.example/x"}}
    assert client.post("/api/push/subscribe", json=bad).status_code == 422


def test_dispatch_requires_the_scheduler_token(repo, sent) -> None:
    client = _client()
    assert client.post("/api/internal/push/dispatch").status_code == 403
    assert (
        client.post(
            "/api/internal/push/dispatch", headers={"X-Push-Token": "nope"}
        ).status_code
        == 403
    )
    ok = client.post("/api/internal/push/dispatch", headers={"X-Push-Token": "tok"})
    assert ok.status_code == 200 and ok.json()["subscriptions"] == 0


def test_training_reminder_at_8am_local_once_per_day(repo, sent) -> None:
    # 2026-10-21 00:05 UTC = 08:05 in Shanghai (a Wednesday).
    now = datetime(2026, 10, 21, 0, 5, tzinfo=UTC)
    weekday = WEEKDAYS[(now + timedelta(hours=8)).weekday()]

    async def scenario():
        await _seed(repo, train_on=[weekday])
        await push.save_subscription(
            repo, {**SUB, "user_id": UID, "lang": "zh", "prefs": {}}
        )
        config = push.PushConfig("p", "k", "mailto:x", "t")
        first = await push.dispatch(config, repo, now)
        again = await push.dispatch(config, repo, now + timedelta(minutes=30))
        return first, again

    first, again = asyncio.run(scenario())
    assert first["sent"] == 1 and again["sent"] == 0  # once per local day
    assert (
        sent[0]["title"]
        == push.message("training", "zh", focus="Legs", minutes=40)["title"]
        and sent[0]["url"] == "/#plan"
    )


def test_meal_reminder_only_when_nothing_logged(repo, sent) -> None:
    # 12:10 UTC = 20:10 in Shanghai.
    now = datetime(2026, 10, 21, 12, 10, tzinfo=UTC)

    async def scenario(with_meal: bool):
        repo_module.get_repository.cache_clear()
        r = repo_module.get_repository()
        await _seed(r)
        if with_meal:
            items = [
                MealItem(
                    name="rice",
                    portion_grams=200,
                    calories_kcal=260,
                    protein_g=5,
                    carbs_g=56,
                    fat_g=1,
                )
            ]
            await r.add_entry(
                UID,
                "meal",
                MealEntry(
                    entry_id="m1",
                    user_id=UID,
                    local_date="2026-10-21",
                    logged_at=now,
                    meal_type="lunch",
                    items=items,
                    totals=sum_meal_items(items),
                ),
            )
        await push.save_subscription(r, {**SUB, "user_id": UID, "lang": "en"})
        return await push.dispatch(push.PushConfig("p", "k", "mailto:x", "t"), r, now)

    assert asyncio.run(scenario(with_meal=True))["sent"] == 0
    assert asyncio.run(scenario(with_meal=False))["sent"] == 1
    assert sent[-1]["title"] == "No meals logged today"


def test_revoked_subscription_is_removed(repo, sent) -> None:
    now = datetime(2026, 10, 21, 12, 10, tzinfo=UTC)
    gone = {**SUB, "endpoint": "https://push.example/gone"}

    async def scenario():
        await _seed(repo)
        await push.save_subscription(repo, {**gone, "user_id": UID})
        stats = await push.dispatch(
            push.PushConfig("p", "k", "mailto:x", "t"), repo, now
        )
        return stats, await push.list_subscriptions(repo)

    stats, left = asyncio.run(scenario())
    assert stats["failed"] == 1 and left == []
