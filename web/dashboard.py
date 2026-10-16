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

"""Progress dashboard data (FR-12).

Every number is computed by the same deterministic ``fitness_core`` functions
the agent tools use (``weight_trend``, ``daily_nutrition_summary``,
``weekly_progress_snapshot``) over the same repository, so the dashboard always
matches what the coach says in chat.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from fitness_core.models import WEEKDAYS
from fitness_core.nutrition import daily_nutrition_summary
from fitness_core.progress import user_local_date, weekly_progress_snapshot
from fitness_core.repository import FitnessRepository
from fitness_core.trends import weight_trend

NUTRITION_DAYS = 14
RANGE_DAYS = (14, 30, 90)
DEFAULT_RANGE_DAYS = 30
STREAK_LOOKBACK_DAYS = 120
WORKOUT_HISTORY_WEEKS = 4


def normalize_range(range_days: int | None) -> int:
    """Clamps a requested range to one of the supported windows (2W/1M/3M)."""
    if range_days in RANGE_DAYS:
        return int(range_days)
    return DEFAULT_RANGE_DAYS


def logging_streak(logged_dates: set[str], today: date) -> int:
    """Consecutive days with at least one meal logged, ending today.

    If nothing is logged yet today, the streak counts back from yesterday so a
    morning visit does not show a broken streak.
    """
    day = today if today.isoformat() in logged_dates else today - timedelta(days=1)
    streak = 0
    while day.isoformat() in logged_dates:
        streak += 1
        day -= timedelta(days=1)
    return streak


async def build_dashboard(
    repo: FitnessRepository,
    user_id: str,
    today: date | None = None,
    range_days: int | None = None,
) -> dict[str, Any]:
    """Builds the dashboard payload for one user.

    Args:
        repo: The fitness data repository.
        user_id: The signed-in user's ID (Google ``sub``).
        today: Override for "today" (defaults to today in the user's time zone).
        range_days: Window for the weight chart (14, 30 or 90 days). Nutrition
            always covers the last 14 days.

    Returns:
        A JSON-serializable dict with targets, weight trend, daily nutrition,
        today's meals and planned session, logging streak, workout completion,
        the current plan and the latest weekly review.
    """
    profile = await repo.get_profile(user_id)
    if profile is None:
        return {"has_profile": False}
    today = today or user_local_date(profile.timezone)
    range_days = normalize_range(range_days)
    first_day = today - timedelta(days=NUTRITION_DAYS - 1)
    range_start = today - timedelta(days=range_days - 1)
    history_start = today - timedelta(days=7 * WORKOUT_HISTORY_WEEKS - 1)

    plan = await repo.get_current_plan(user_id)
    measurements = await repo.list_measurements(user_id)
    meals = await repo.list_meals(
        user_id,
        start=(today - timedelta(days=STREAK_LOOKBACK_DAYS)).isoformat(),
        end=today.isoformat(),
    )
    workouts = await repo.list_workouts(
        user_id, start=history_start.isoformat(), end=today.isoformat()
    )
    review = await repo.latest_weekly_review(user_id)

    trend = weight_trend(measurements, starting_weight_kg=profile.starting_weight_kg)
    days = [
        daily_nutrition_summary(
            (first_day + timedelta(days=i)).isoformat(), meals, profile.targets
        )
        for i in range(NUTRITION_DAYS)
    ]
    week_start = today - timedelta(days=6)
    week_workouts = [w for w in workouts if w.local_date >= week_start.isoformat()]
    snapshot = weekly_progress_snapshot(
        profile=profile,
        plan=plan,
        workouts=week_workouts,
        meals=[m for m in meals if m.local_date >= week_start.isoformat()],
        measurements=measurements,
        week_end=today,
    )
    week_dates = {w.local_date for w in week_workouts}
    weekday = WEEKDAYS[today.weekday()]
    today_session = next(
        (s for s in plan.sessions if s.day_of_week == weekday), None
    ) if plan else None
    meals_today = sorted(
        (m for m in meals if m.local_date == today.isoformat()),
        key=lambda m: m.logged_at,
    )
    workout_history = []
    for week in range(WORKOUT_HISTORY_WEEKS - 1, -1, -1):
        end = today - timedelta(days=7 * week)
        start = end - timedelta(days=6)
        workout_history.append(
            {
                "week_start": start.isoformat(),
                "week_end": end.isoformat(),
                "sessions": len(
                    {
                        w.local_date
                        for w in workouts
                        if start.isoformat() <= w.local_date <= end.isoformat()
                    }
                ),
            }
        )

    return {
        "has_profile": True,
        "today": today.isoformat(),
        "weekday": weekday,
        "timezone": profile.timezone,
        "goal": profile.goal,
        "range_days": range_days,
        "targets": profile.targets.model_dump(mode="json") if profile.targets else None,
        "weight": {
            "points": [
                p.model_dump(mode="json")
                for p in trend.points
                if p.local_date >= range_start.isoformat()
            ],
            **trend.model_dump(mode="json", exclude={"points"}),
        },
        "nutrition": {
            "days": [
                {
                    "local_date": d.local_date,
                    "meals_logged": d.meals_logged,
                    "calories_kcal": d.consumed.calories_kcal,
                    "protein_g": d.consumed.protein_g,
                    "carbs_g": d.consumed.carbs_g,
                    "fat_g": d.consumed.fat_g,
                    "target_calories_kcal": d.target_calories_kcal,
                    "target_protein_g": d.target_protein_g,
                    "protein_target_hit": d.protein_target_hit,
                }
                for d in days
            ],
            "days_logged": sum(1 for d in days if d.meals_logged),
            "protein_hit_days": sum(1 for d in days if d.protein_target_hit),
            "today": days[-1].model_dump(mode="json"),
            "meals_today": [
                {
                    "entry_id": m.entry_id,
                    "meal_type": m.meal_type,
                    "logged_at": m.logged_at.isoformat(),
                    "items": [i.name for i in m.items],
                    "totals": m.totals.model_dump(mode="json"),
                    "source": m.source,
                }
                for m in meals_today
            ],
            "logging_streak_days": logging_streak({m.local_date for m in meals}, today),
        },
        "week": {
            **snapshot.model_dump(mode="json"),
            "workout_dates": sorted(week_dates),
            "history": workout_history,
        },
        "plan": plan.model_dump(mode="json") if plan else None,
        "today_session": today_session.model_dump(mode="json") if today_session else None,
        "today_session_done": today.isoformat() in week_dates,
        "latest_review": review.model_dump(mode="json") if review else None,
    }
