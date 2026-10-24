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

"""Admin analytics metric definitions (web/analytics.py)."""

from __future__ import annotations

from datetime import date, timedelta

from web.analytics import build_analytics

TODAY = date(2026, 10, 24)


def _d(n: int) -> str:
    return (TODAY - timedelta(days=n)).isoformat()


def _user(uid: str, active_days_ago: list[int], email: str = "") -> dict:
    dates = sorted(_d(n) for n in active_days_ago)
    return {
        "user_id": uid,
        "email": email,
        "active_dates": dates,
        "first_day": dates[0] if dates else _d(0),
    }


def _turn(uid: str, day_ago: int, ts: float, **kw) -> dict:
    return {
        "kind": "chat_turn",
        "user_id": uid,
        "day": _d(day_ago),
        "ts": ts,
        "intent": kw.get("intent", "message"),
        "outcome": kw.get("outcome", "ok"),
        "card_events": kw.get("cards", 0),
        "agents": kw.get("agents", ["fitness_coach"]),
    }


def test_adoption_retention_churn_growth_and_seats() -> None:
    users = [
        _user("a", [0, 8], "a@x.com"),  # active both 7-day windows -> retained
        _user("b", [9], "b@x.com"),  # previous window only -> churned
        _user("c", [1]),  # current window only -> new
        _user("d", [2]),
    ]
    access = [
        {"email": "a@x.com", "status": "approved"},
        {"email": "b@x.com", "status": "approved"},
        {"email": "z@x.com", "status": "approved"},  # never signed in
        {"email": "p@x.com", "status": "pending"},
    ]
    out = build_analytics(
        users=users,
        chat_events=[],
        ui_events=[],
        feedback=[],
        access_entries=access,
        today=TODAY,
        days=14,
    )["adoption"]
    cur = out["rates"]["7d"]["current"]
    # previous window {a, b}; current window {a, c, d}
    assert cur["previous"] == 2 and cur["active"] == 3
    assert cur["retention_pct"] == 50.0
    assert cur["churn_pct"] == 50.0
    assert cur["growth_pct"] == 50.0
    assert len(out["active_users"]["daily"]) == 14
    assert out["active_users"]["daily"][-1] == {"period": _d(0), "users": 1}
    assert out["active_users"]["weekly"][-1]["period"] == _d(TODAY.weekday())
    assert out["active_users"]["monthly"][-1]["period"] == "2026-10"
    assert out["seats"] == {"granted": 3, "claimed": 2, "claim_rate_pct": 66.7}


def test_usage_quality_successful_answers_and_feedback() -> None:
    turns = [
        _turn("a", 0, 1000.0),  # re-asked 10 s later -> not successful
        _turn("a", 0, 1010.0, cards=1),  # successful (logged a meal)
        _turn("b", 0, 2000.0, intent="photo"),  # successful
        _turn("b", 0, 3000.0, outcome="agent_error"),  # question, no answer
        _turn("b", 0, 3100.0, intent="confirm"),  # action, not a question
        _turn("c", 20, 500.0),  # outside the 7-day range
    ]
    feedback = [
        {
            "rating": "down",
            "tags": ["wrong_numbers", "too_slow", "meal_card"],
            "created_at": _d(0) + "T10:00:00",
        },
        {"rating": "up", "created_at": _d(0) + "T11:00:00"},
    ]
    ui = [
        {"name": "tab_view", "tab": "plan", "day": _d(0)},
        {"name": "tab_view", "tab": "plan", "day": _d(1)},
        {"name": "tab_view", "tab": "today", "day": _d(0)},
    ]
    out = build_analytics(
        users=[],
        chat_events=turns,
        ui_events=ui,
        feedback=feedback,
        access_entries=[],
        today=TODAY,
        days=7,
    )
    uq = out["usage_quality"]
    assert uq["questions"] == 4
    assert uq["photo_questions"] == 1
    assert uq["answers"] == 3
    assert uq["actions"] == 2  # one card + one confirm
    # 2 answers without a quick follow-up, minus 1 thumbs-down
    assert uq["successful_answers"] == 1
    assert uq["likes"] == 1 and uq["dislikes"] == 1
    assert {r["reason"]: r["pct"] for r in uq["dislike_reasons"]} == {
        "too_slow": 100.0,
        "wrong_numbers": 100.0,
    }
    assert uq["page_views"][0] == {"tab": "plan", "count": 2}
    assert uq["series"][-1]["questions"] == 4
    assert out["value"]["successful_answers"] == 1


def test_agents_sessions_are_user_agent_days() -> None:
    turns = [
        _turn("a", 0, 1.0, agents=["fitness_coach"]),
        _turn("a", 0, 2.0, agents=["fitness_coach", "nutrition_coach"]),
        _turn("a", 1, 3.0, agents=["fitness_coach"]),
        _turn("b", 0, 4.0, agents=["workout_planner", "plan_critic"]),
        _turn("c", 0, 5.0, agents=[]),  # recorded before agent tracking
    ]
    ag = build_analytics(
        users=[],
        chat_events=turns,
        ui_events=[],
        feedback=[],
        access_entries=[],
        today=TODAY,
        days=7,
    )["agents"]
    rows = {r["agent"]: r for r in ag["by_agent"]}
    assert rows["fitness_coach"] == {
        "agent": "fitness_coach",
        "users": 1,
        "sessions": 2,
        "turns": 3,
    }
    assert rows["nutrition_coach"]["sessions"] == 1
    assert ag["agents_used"] == 4
    assert ag["active_agent_users"] == 2
    assert ag["total_chat_sessions"] == 4  # (a,d0) (a,d1) (b,d0) (c,d0)
    assert ag["attributed_turns"] == 4 and ag["total_turns"] == 5
