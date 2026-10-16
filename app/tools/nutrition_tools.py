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

"""Meal logging and nutrition summary tools (FR-4)."""

from datetime import date
from typing import Any, Literal

from google.adk.tools import ToolContext
from pydantic import ValidationError

from app.observability.tracing import domain_span
from app.tools._common import (
    load_profile,
    local_today,
    repository,
    storage_user_id,
    tool_error,
    validation_error,
)
from fitness_core.models import MealEntry, MealItem, MealType, utc_now
from fitness_core.nutrition import daily_nutrition_summary, sum_meal_items
from fitness_core.repository import new_entry_id


async def log_meal_entry(
    items: list[MealItem],
    meal_type: MealType,
    tool_context: ToolContext,
    source: Literal["photo", "text"] = "photo",
    meal_date: str | None = None,
    replaces_entry_id: str | None = None,
) -> dict[str, Any]:
    """Logs a meal from per-item estimates; totals are computed in code.

    Estimate each visible food separately (name, portion in grams, kcal,
    protein, carbs, fat, confidence). Do not sum the items yourself; this tool
    computes the meal totals and today's remaining calories and protein.

    Args:
        items: One entry per food item with estimated portion and macros.
        meal_type: breakfast, lunch, dinner or snack.
        source: ``photo`` when estimated from an image, ``text`` from a description.
        meal_date: YYYY-MM-DD; omit for today in the user's time zone.
        replaces_entry_id: Set when the user corrects a meal you already logged;
            the old entry is replaced by this one.

    Returns:
        The saved entry with computed totals and the day's nutrition summary
        (consumed, targets, remaining calories and protein).
    """
    profile = await load_profile(tool_context)
    today = local_today(profile)
    day = meal_date or today.isoformat()
    try:
        if date.fromisoformat(day) > today:
            return tool_error("The meal date is in the future.", "Omit meal_date or ask which day was meant.")
    except ValueError:
        return tool_error(f"'{day}' is not a valid date.", "Use YYYY-MM-DD or omit meal_date.")
    try:
        entry = MealEntry(
            entry_id=replaces_entry_id or new_entry_id(),
            user_id=storage_user_id(tool_context),
            local_date=day,
            logged_at=utc_now(),
            meal_type=meal_type,
            items=items,
            totals=sum_meal_items(items),
            source=source,
        )
    except ValidationError as exc:
        return validation_error(exc, "meal")

    repo = repository()
    with domain_span("firestore.add_meal", items=len(items), replaced=bool(replaces_entry_id)):
        await repo.add_entry(storage_user_id(tool_context), "meal", entry)
    summary = daily_nutrition_summary(day, await repo.list_meals(storage_user_id(tool_context), day, day), profile.targets if profile else None)
    return {
        "status": "logged",
        "entry_id": entry.entry_id,
        "meal_type": entry.meal_type,
        "items": [item.model_dump() for item in entry.items],
        "meal_totals": entry.totals.model_dump(),
        "is_estimate": True,
        "daily_summary": summary.model_dump(),
        "advisory": None if profile and profile.targets else "No targets yet: suggest finishing onboarding.",
    }


async def get_daily_nutrition_summary(tool_context: ToolContext, day: str | None = None) -> dict[str, Any]:
    """Returns calories and macros eaten on a day versus the user's targets.

    Args:
        day: YYYY-MM-DD; omit for today in the user's time zone.

    Returns:
        Consumed totals, number of meals, targets, remaining calories and protein.
    """
    profile = await load_profile(tool_context)
    day = day or local_today(profile).isoformat()
    with domain_span("daily_nutrition_summary"):
        meals = await repository().list_meals(storage_user_id(tool_context), day, day)
        summary = daily_nutrition_summary(day, meals, profile.targets if profile else None)
    return {"status": "ok", "summary": summary.model_dump()}
