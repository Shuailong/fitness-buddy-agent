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

"""One-off day adjustments and single-weekday plan edits (coach tools)."""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from app.tools.context_tools import local_date_prompt
from app.tools.planning_tools import (
    adjust_planned_day,
    clear_planned_day_adjustment,
    get_current_training_plan,
    update_weekly_plan_day,
)
from fitness_core import repository as repo_module
from fitness_core.models import (
    WEEKDAYS,
    FitnessProfile,
    PlanAdjustment,
    PlannedExercise,
    PlannedSession,
    TrainingPlan,
)
from fitness_core.plans import effective_session, effective_week
from fitness_core.progress import user_local_date

UID = "u-adjust"


class FakeToolContext:
    def __init__(self, confirmed: bool | None = None) -> None:
        self.user_id = UID
        self.session = SimpleNamespace(id="s1")
        self.tool_confirmation = (
            None if confirmed is None else SimpleNamespace(confirmed=confirmed)
        )
        self.actions = SimpleNamespace(skip_summarization=False)
        self.requested: list[dict[str, Any]] = []

    def request_confirmation(self, *, hint: str, payload: dict[str, Any]) -> None:
        self.requested.append({"hint": hint, "payload": payload})


@pytest.fixture
def repo(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FITNESS_STORAGE_BACKEND", "memory")
    monkeypatch.delenv("FITNESS_EVAL_ISOLATION", raising=False)
    repo_module.get_repository.cache_clear()
    r = repo_module.get_repository()
    asyncio.run(_seed(r))
    yield r
    repo_module.get_repository.cache_clear()


def _ex(exercise_id: str, name: str, reps: int = 10) -> PlannedExercise:
    return PlannedExercise(exercise_id=exercise_id, name=name, sets=3, reps=reps)


def _plan() -> TrainingPlan:
    return TrainingPlan(
        title="Split",
        goal="recomposition",
        sessions=[
            PlannedSession(
                day_of_week=day,
                focus=focus,
                estimated_minutes=40,
                exercises=[_ex("one_arm_dumbbell_row", "Row"), _ex("plank", "Plank")],
            )
            for day, focus in (
                ("monday", "Push"),
                ("tuesday", "Pull"),
                ("wednesday", "Legs"),
                ("thursday", "Arms"),
                ("friday", "Full body"),
            )
        ],
    )


async def _seed(r) -> None:
    await r.save_profile(
        FitnessProfile(
            user_id=UID,
            goal="recomposition",
            sex="male",
            age=35,
            height_cm=175,
            starting_weight_kg=72,
            training_days_per_week=5,
            minutes_per_session=45,
            equipment=["dumbbells"],
            injury_areas=["knee"],
            timezone="UTC",
        )
    )
    await r.save_current_plan(UID, _plan())


def test_effective_week_applies_adjustments_by_date() -> None:
    plan = _plan()
    tuesday = date(2026, 10, 20)
    light = PlannedSession(
        day_of_week="tuesday",
        focus="Mobility",
        estimated_minutes=15,
        exercises=[_ex("cat_cow", "Cat-Cow")],
    )
    adjustments = [
        PlanAdjustment(local_date="2026-10-20", day_of_week="tuesday", session=light),
        PlanAdjustment(local_date="2026-10-22", day_of_week="thursday", session=None),
    ]
    session, adj = effective_session(plan, adjustments, tuesday)
    assert session.focus == "Mobility" and adj is not None
    # The same weekday next week follows the weekly plan again.
    session, adj = effective_session(plan, adjustments, tuesday + timedelta(days=7))
    assert session.focus == "Pull" and adj is None
    week = effective_week(plan, adjustments, tuesday)
    assert week[0]["date"] == "2026-10-19" and len(week) == 7
    by_day = {d["day_of_week"]: d for d in week}
    assert (
        by_day["tuesday"]["adjusted"]
        and by_day["tuesday"]["session"]["focus"] == "Mobility"
    )
    assert by_day["thursday"]["adjusted"] and by_day["thursday"]["session"] is None
    assert (
        not by_day["monday"]["adjusted"]
        and by_day["monday"]["session"]["focus"] == "Push"
    )
    assert by_day["sunday"]["session"] is None and not by_day["sunday"]["adjusted"]


def test_adjust_today_saves_immediately_and_keeps_weekly_plan(repo) -> None:
    async def scenario() -> None:
        ctx = FakeToolContext()
        result = await adjust_planned_day(
            ctx,
            day="today",
            exercises=[_ex("dead_bug", "Dead Bug", 12), _ex("cat_cow", "Cat-Cow")],
            focus="Home core (short)",
            reason="Only 20 minutes at home",
        )
        today = user_local_date("UTC")
        assert result["status"] == "saved", result
        assert result["is_today"] and result["date"] == today.isoformat()
        assert result["session"]["estimated_minutes"] < 45  # estimated in code
        assert not ctx.requested  # one-off change: no confirmation card
        stored = await repo.list_plan_adjustments(UID)
        assert [a.local_date for a in stored] == [today.isoformat()]
        assert stored[0].reason == "Only 20 minutes at home"
        # The weekly template is untouched.
        assert len((await repo.get_current_plan(UID)).sessions) == 5
        # The coach sees it in the plan overview.
        overview = await get_current_training_plan(ctx)
        assert overview["today"]["weekday"] == WEEKDAYS[today.weekday()]
        today_row = next(
            d for d in overview["this_week"] if d["date"] == today.isoformat()
        )
        assert today_row["adjusted"] and today_row["focus"] == "Home core (short)"
        # Undo restores the weekly plan for that date.
        cleared = await clear_planned_day_adjustment(ctx, day="today")
        assert cleared["status"] == "cleared"
        assert await repo.list_plan_adjustments(UID) == []

    asyncio.run(scenario())


def test_adjust_day_rejects_unsafe_or_out_of_range_changes(repo) -> None:
    async def scenario() -> None:
        ctx = FakeToolContext()
        # Knee injury: goblet squats are contraindicated; barbell not owned.
        bad = await adjust_planned_day(
            ctx,
            day="tomorrow",
            exercises=[
                _ex("goblet_squat", "Goblet Squat"),
                _ex("barbell_deadlift", "Deadlift"),
            ],
        )
        assert bad["status"] == "error"
        rules = {v["rule"] for v in bad["violations"]}
        assert {"injury_conflict", "missing_equipment"} <= rules
        past = (user_local_date("UTC") - timedelta(days=1)).isoformat()
        assert (await adjust_planned_day(ctx, day=past, rest_day=True))[
            "status"
        ] == "error"
        assert (await adjust_planned_day(ctx, day="today"))["status"] == "error"
        assert await repo.list_plan_adjustments(UID) == []
        # Rest day: allowed, no exercises needed.
        rest = await adjust_planned_day(
            ctx, day="tomorrow", rest_day=True, reason="Party"
        )
        assert rest["status"] == "saved" and rest["rest_day"] is True

    asyncio.run(scenario())


def test_weekday_name_resolves_to_next_occurrence(repo) -> None:
    async def scenario() -> None:
        today = user_local_date("UTC")
        target = WEEKDAYS[(today.weekday() + 2) % 7]
        result = await adjust_planned_day(FakeToolContext(), day=target, rest_day=True)
        assert result["date"] == (today + timedelta(days=2)).isoformat()

    asyncio.run(scenario())


def test_update_weekly_plan_day_requires_confirmation(repo) -> None:
    async def scenario() -> None:
        new = [_ex("one_arm_dumbbell_row", "Row"), _ex("dead_bug", "Dead Bug", 12)]
        first_ctx = FakeToolContext()
        pending = await update_weekly_plan_day("tuesday", first_ctx, exercises=new)
        assert pending["status"] == "pending_confirmation"
        card = first_ctx.requested[0]["payload"]
        assert card["kind"] == "update_plan_day"
        assert card["details"]["sessions"][0]["day"] == "tuesday"
        plan = await repo.get_current_plan(UID)
        assert [e.exercise_id for e in plan.sessions[1].exercises] == [
            "one_arm_dumbbell_row",
            "plank",
        ]
        rejected = await update_weekly_plan_day(
            "tuesday", FakeToolContext(confirmed=False), exercises=new
        )
        assert rejected["status"] == "rejected_by_user"
        saved = await update_weekly_plan_day(
            "tuesday", FakeToolContext(confirmed=True), exercises=new
        )
        assert saved["status"] == "saved"
        plan = await repo.get_current_plan(UID)
        tuesday = next(s for s in plan.sessions if s.day_of_week == "tuesday")
        assert [e.exercise_id for e in tuesday.exercises] == [
            "one_arm_dumbbell_row",
            "dead_bug",
        ]
        assert tuesday.focus == "Pull" and len(plan.sessions) == 5
        # Removing a day keeps the others.
        removed = await update_weekly_plan_day(
            "friday", FakeToolContext(confirmed=True), remove_session=True
        )
        assert removed["status"] == "saved"
        assert len((await repo.get_current_plan(UID)).sessions) == 4

    asyncio.run(scenario())


def test_local_date_prompt_names_the_weekday() -> None:
    now = datetime(2026, 10, 20, 14, 26, tzinfo=UTC)  # 22:26 in Shanghai
    text = local_date_prompt("Asia/Shanghai", now)
    assert "Tuesday, 2026-10-20" in text and "22:26" in text
    late = datetime(2026, 10, 20, 17, 0, tzinfo=UTC)  # already Wednesday there
    assert "Wednesday, 2026-10-21" in local_date_prompt("Asia/Shanghai", late)
    assert "UTC" in local_date_prompt("Not/AZone", now)


def test_ui_language_marker_reaches_every_agent() -> None:
    from app.tools.context_tools import language_prompt, ui_language

    class Ctx:
        def __init__(self, parts, state=None):
            self.user_content = SimpleNamespace(
                parts=[SimpleNamespace(text=p) for p in parts]
            )
            self.state = state if state is not None else {}

    state: dict = {}
    # Photo-only turn: the only text part is the hidden marker.
    assert ui_language(Ctx([None, "[UI language: zh-CN]"], state)) == "zh"
    assert state["ui_lang"] == "zh"
    # A resumed turn (confirmation) has no marker: the session remembers it.
    assert ui_language(Ctx([None], state)) == "zh"
    assert ui_language(Ctx(["hello", "[UI language: en]"], state)) == "en"
    assert "Simplified Chinese" in language_prompt("zh") and "food" in language_prompt(
        "zh"
    )
