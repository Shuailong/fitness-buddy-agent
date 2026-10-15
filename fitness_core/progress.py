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

"""Weekly progress snapshots (FR-7) and due check-ins (FR-8)."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel

from fitness_core.models import (
    WEEKDAYS,
    BodyMeasurement,
    CheckInState,
    FitnessProfile,
    MealEntry,
    TrainingPlan,
    WorkoutSession,
    utc_now,
)
from fitness_core.nutrition import daily_nutrition_summary
from fitness_core.trends import weight_trend

MAX_CHECK_INS = 3
WEEKLY_REVIEW_INTERVAL_DAYS = 7


def user_local_date(timezone: str, now: datetime | None = None) -> date:
    """Returns today's date in the user's time zone (falls back to UTC).

    Args:
        timezone: IANA time zone name, e.g. ``Asia/Shanghai``.
        now: Optional reference time (timezone-aware); defaults to now.

    Returns:
        The local calendar date.
    """
    now = now or utc_now()
    try:
        return now.astimezone(ZoneInfo(timezone)).date()
    except (ZoneInfoNotFoundError, ValueError):
        return now.date()


class WeeklyProgressSnapshot(BaseModel):
    """Deterministic aggregates for the 7 days ending on ``week_end``."""

    week_start: str
    week_end: str
    planned_sessions: int
    completed_sessions: int
    workout_completion_rate: float | None
    days_with_meals_logged: int
    average_daily_calories_kcal: float | None
    target_calories_kcal: int | None
    average_calorie_gap_kcal: float | None
    protein_target_hit_days: int
    weight_moving_average_start_kg: float | None
    weight_moving_average_end_kg: float | None
    weight_change_kg: float | None


def weekly_progress_snapshot(
    *,
    profile: FitnessProfile,
    plan: TrainingPlan | None,
    workouts: Iterable[WorkoutSession],
    meals: Iterable[MealEntry],
    measurements: Iterable[BodyMeasurement],
    week_end: date,
) -> WeeklyProgressSnapshot:
    """Aggregates adherence and outcomes for the 7 days ending on ``week_end``.

    Args:
        profile: The user's profile (targets).
        plan: The current training plan, if any.
        workouts: Workout sessions (any range; filtered here).
        meals: Meal entries (any range; filtered here).
        measurements: Body measurements (any range; filtered here).
        week_end: Last day of the 7-day window (inclusive).

    Returns:
        The weekly snapshot.
    """
    week_start = week_end - timedelta(days=6)
    in_week = lambda d: week_start.isoformat() <= d <= week_end.isoformat()  # noqa: E731
    week_workouts = [w for w in workouts if in_week(w.local_date)]
    week_meals = [m for m in meals if in_week(m.local_date)]
    planned = len(plan.sessions) if plan else 0
    completed = len({w.local_date for w in week_workouts})

    targets = profile.targets
    daily = [
        daily_nutrition_summary(day, week_meals, targets)
        for day in sorted({m.local_date for m in week_meals})
    ]
    avg_kcal = round(sum(d.consumed.calories_kcal for d in daily) / len(daily), 1) if daily else None
    target_kcal = targets.daily_calories_kcal if targets else None
    gap = round(avg_kcal - target_kcal, 1) if avg_kcal is not None and target_kcal else None

    measurements = list(measurements)
    end_trend = weight_trend([m for m in measurements if m.local_date <= week_end.isoformat()])
    start_trend = weight_trend([m for m in measurements if m.local_date < week_start.isoformat()])
    start_avg = start_trend.latest_moving_average_kg
    end_avg = end_trend.latest_moving_average_kg
    return WeeklyProgressSnapshot(
        week_start=week_start.isoformat(),
        week_end=week_end.isoformat(),
        planned_sessions=planned,
        completed_sessions=completed,
        workout_completion_rate=round(min(completed / planned, 1.0), 2) if planned else None,
        days_with_meals_logged=len(daily),
        average_daily_calories_kcal=avg_kcal,
        target_calories_kcal=target_kcal,
        average_calorie_gap_kcal=gap,
        protein_target_hit_days=sum(1 for d in daily if d.protein_target_hit),
        weight_moving_average_start_kg=start_avg,
        weight_moving_average_end_kg=end_avg,
        weight_change_kg=round(end_avg - start_avg, 2) if start_avg and end_avg else None,
    )


class CheckInItem(BaseModel):
    """Something the coach should raise at the start of a conversation."""

    key: str
    kind: Literal["missed_workout_log", "measurement_due", "weekly_review_due"]
    message: str


def due_check_ins(
    *,
    profile: FitnessProfile,
    plan: TrainingPlan | None,
    workouts: Iterable[WorkoutSession],
    measurements: Iterable[BodyMeasurement],
    latest_review_date: date | None,
    state: CheckInState,
    today: date,
) -> list[CheckInItem]:
    """Lists due check-ins, newest-priority first, skipping ones already raised.

    Priority: missed workout logs this week, then measurement due, then weekly
    review due. At most ``MAX_CHECK_INS`` items are returned.

    Args:
        profile: The user's profile.
        plan: Current training plan, if any.
        workouts: Logged workout sessions.
        measurements: Logged body measurements.
        latest_review_date: Date of the latest weekly review, if any.
        state: Keys already raised (to avoid repeats).
        today: Today in the user's time zone.

    Returns:
        Up to three new check-in items.
    """
    items: list[CheckInItem] = []
    logged_days = {w.local_date for w in workouts}

    if plan:
        planned_days = {s.day_of_week for s in plan.sessions}
        monday = today - timedelta(days=today.weekday())
        for offset in range(today.weekday()):  # days this week before today
            day = monday + timedelta(days=offset)
            weekday = WEEKDAYS[day.weekday()]
            if weekday in planned_days and day.isoformat() not in logged_days:
                items.append(
                    CheckInItem(
                        key=f"missed_workout_log:{day.isoformat()}",
                        kind="missed_workout_log",
                        message=f"The planned {weekday.title()} ({day.isoformat()}) workout is not logged yet.",
                    )
                )

    weights = [m for m in measurements if m.weight_kg is not None]
    last_weigh_in = max((date.fromisoformat(m.local_date) for m in weights), default=None)
    reference = last_weigh_in or profile.created_at.date()
    if (today - reference).days >= profile.measurement_interval_days:
        items.append(
            CheckInItem(
                key=f"measurement_due:{today.isoformat()}",
                kind="measurement_due",
                message="It's time for your regular weigh-in (and waist / body-fat if you track them).",
            )
        )

    review_reference = latest_review_date or profile.created_at.date()
    if (today - review_reference).days >= WEEKLY_REVIEW_INTERVAL_DAYS:
        items.append(
            CheckInItem(
                key=f"weekly_review_due:{today.isoformat()}",
                kind="weekly_review_due",
                message="Your weekly review is ready to run whenever you are.",
            )
        )

    raised = set(state.raised_keys)
    return [i for i in items if i.key not in raised][:MAX_CHECK_INS]
