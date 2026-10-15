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

from fitness_core.nutrition import daily_nutrition_summary
from fitness_core.progress import user_local_date, weekly_progress_snapshot
from fitness_core.repository import FitnessRepository
from fitness_core.trends import weight_trend

WEIGHT_POINTS = 30
NUTRITION_DAYS = 14


async def build_dashboard(
    repo: FitnessRepository, user_id: str, today: date | None = None
) -> dict[str, Any]:
    """Builds the dashboard payload for one user.

    Args:
        repo: The fitness data repository.
        user_id: The signed-in user's ID (Google ``sub``).
        today: Override for "today" (defaults to today in the user's time zone).

    Returns:
        A JSON-serializable dict with targets, weight trend, 14-day nutrition,
        this week's workout completion and the current plan.
    """
    profile = await repo.get_profile(user_id)
    if profile is None:
        return {"has_profile": False}
    today = today or user_local_date(profile.timezone)
    first_day = today - timedelta(days=NUTRITION_DAYS - 1)

    plan = await repo.get_current_plan(user_id)
    measurements = await repo.list_measurements(user_id)
    meals = await repo.list_meals(
        user_id, start=first_day.isoformat(), end=today.isoformat()
    )
    workouts = await repo.list_workouts(
        user_id, start=(today - timedelta(days=6)).isoformat(), end=today.isoformat()
    )

    trend = weight_trend(measurements, starting_weight_kg=profile.starting_weight_kg)
    days = [
        daily_nutrition_summary(
            (first_day + timedelta(days=i)).isoformat(), meals, profile.targets
        )
        for i in range(NUTRITION_DAYS)
    ]
    snapshot = weekly_progress_snapshot(
        profile=profile,
        plan=plan,
        workouts=workouts,
        meals=meals,
        measurements=measurements,
        week_end=today,
    )
    week_dates = {w.local_date for w in workouts}

    return {
        "has_profile": True,
        "today": today.isoformat(),
        "timezone": profile.timezone,
        "goal": profile.goal,
        "targets": profile.targets.model_dump(mode="json") if profile.targets else None,
        "weight": {
            "points": [
                p.model_dump(mode="json") for p in trend.points[-WEIGHT_POINTS:]
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
        },
        "week": {
            **snapshot.model_dump(mode="json"),
            "workout_dates": sorted(week_dates),
        },
        "plan": plan.model_dump(mode="json") if plan else None,
    }
