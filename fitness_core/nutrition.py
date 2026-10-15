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

"""Meal totals and daily nutrition summaries (computed in code, never by the LLM)."""

from __future__ import annotations

from collections.abc import Iterable

from pydantic import BaseModel, Field

from fitness_core.models import EnergyTargets, MealEntry, MealItem, MealTotals


def sum_meal_items(items: Iterable[MealItem]) -> MealTotals:
    """Sums per-item estimates into meal totals, rounded to 0.1.

    Args:
        items: The meal items to sum.

    Returns:
        The summed calories and macros.
    """
    items = list(items)
    return MealTotals(
        calories_kcal=round(sum(i.calories_kcal for i in items), 1),
        protein_g=round(sum(i.protein_g for i in items), 1),
        carbs_g=round(sum(i.carbs_g for i in items), 1),
        fat_g=round(sum(i.fat_g for i in items), 1),
    )


class DailyNutritionSummary(BaseModel):
    """What the user ate on a day versus their targets."""

    local_date: str
    meals_logged: int
    consumed: MealTotals
    target_calories_kcal: int | None = None
    target_protein_g: int | None = None
    remaining_calories_kcal: float | None = Field(
        default=None, description="Negative when the user is over target."
    )
    remaining_protein_g: float | None = None
    protein_target_hit: bool | None = None


def daily_nutrition_summary(
    local_date: str, meals: Iterable[MealEntry], targets: EnergyTargets | None
) -> DailyNutritionSummary:
    """Builds the nutrition summary for one day.

    Args:
        local_date: The day in the user's time zone, ``YYYY-MM-DD``.
        meals: All meal entries; only those on ``local_date`` are counted.
        targets: The user's current targets, or None if not set yet.

    Returns:
        Consumed totals, and remaining amounts when targets exist.
    """
    day_meals = [m for m in meals if m.local_date == local_date]
    consumed = sum_meal_items(item for m in day_meals for item in m.items)
    summary = DailyNutritionSummary(
        local_date=local_date, meals_logged=len(day_meals), consumed=consumed
    )
    if targets is not None:
        summary.target_calories_kcal = targets.daily_calories_kcal
        summary.target_protein_g = targets.protein_g
        summary.remaining_calories_kcal = round(
            targets.daily_calories_kcal - consumed.calories_kcal, 1
        )
        summary.remaining_protein_g = round(targets.protein_g - consumed.protein_g, 1)
        summary.protein_target_hit = consumed.protein_g >= targets.protein_g
    return summary
