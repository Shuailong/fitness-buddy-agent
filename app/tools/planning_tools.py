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

"""Training-plan tools used by the workout planner (FR-3)."""

from typing import Any, Literal

from google.adk.tools import ToolContext

from app.observability.tracing import domain_span
from app.tools._common import (
    confirmation_gate,
    load_profile,
    missing_profile_error,
    repository,
    storage_user_id,
    tool_error,
)
from fitness_core.models import TrainingPlan
from fitness_core.plans import known_muscles, search_exercises, validate_training_plan


async def search_exercise_library(
    tool_context: ToolContext,
    muscle: str | None = None,
    category: Literal["strength", "core", "cardio", "mobility"] | None = None,
) -> dict[str, Any]:
    """Finds exercises the user can do safely with their own equipment.

    Results are already filtered by the user's equipment and injury areas, so
    only use ``exercise_id`` values returned here when building a plan.

    Args:
        muscle: Optional target muscle, e.g. quads, glutes, hamstrings, chest,
            upper_back, lats, shoulders, biceps, triceps, core, cardio.
        category: Optional category: strength, core, cardio or mobility.

    Returns:
        ``{"status": "ok", "exercises": [{id, name, category, muscles, equipment}]}``.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    with domain_span("exercise_search", muscle=muscle, category=category):
        found = search_exercises(
            available_equipment=profile.equipment,
            injury_areas=profile.injury_areas,
            muscle=muscle,
            category=category,
        )
    if not found:
        return tool_error(
            "No safe exercises match this filter for the user's equipment and injuries.",
            "Retry with one of the valid muscle names, or drop the muscle/category filter.",
            valid_muscles=known_muscles(),
        )
    return {
        "status": "ok",
        "exercises": [e.model_dump(exclude={"contraindications"}) for e in found],
    }


async def validate_training_plan_constraints(plan: TrainingPlan, tool_context: ToolContext) -> dict[str, Any]:
    """Deterministically checks a draft plan against the user's constraints.

    Checks equipment, injury contraindications, session count vs. training days,
    duplicate days and the per-session time limit (duration estimated in code).

    Args:
        plan: The draft weekly training plan.

    Returns:
        ``is_valid``, every violation with a ``suggested_fix``, and the
        code-estimated minutes per session. Fix all violations before saving.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    with domain_span("plan_validation", sessions=len(plan.sessions)) as span:
        result = validate_training_plan(plan, profile)
        span.set_attribute("fitness_buddy.plan_valid", result.is_valid)
    return {"status": "ok", **result.model_dump()}


async def save_weekly_training_plan(plan: TrainingPlan, tool_context: ToolContext) -> dict[str, Any]:
    """Saves a plan as the user's current plan (requires user confirmation).

    The plan is re-validated in code first; an invalid plan is never shown to
    the user for confirmation. After confirmation the previous plan is archived.

    Args:
        plan: The final, validated weekly training plan.

    Returns:
        ``status`` is ``saved``, ``pending_confirmation``, ``rejected_by_user``
        or a guided error listing violations to fix.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    result = validate_training_plan(plan, profile)
    if not result.is_valid:
        return tool_error(
            "The plan violates the user's constraints and cannot be saved.",
            "Apply each suggested_fix, re-run validate_training_plan_constraints, then save again.",
            violations=[v.model_dump(exclude_none=True) for v in result.violations],
        )
    repo = repository()
    current = await repo.get_current_plan(storage_user_id(tool_context))
    overview = "; ".join(
        f"{s.day_of_week.title()}: {s.focus} (~{result.estimated_minutes_by_day[s.day_of_week]} min)"
        for s in plan.sessions
    )
    stop = confirmation_gate(
        tool_context,
        action="replace_training_plan",
        title="Replace your current training plan?" if current else "Save this training plan?",
        summary=f"{plan.title}: {overview}"
        + (f". This replaces '{current.title}'." if current else "."),
        details={
            "title": plan.title,
            "sessions": [
                {
                    "day": s.day_of_week,
                    "focus": s.focus,
                    "minutes": result.estimated_minutes_by_day[s.day_of_week],
                    "exercises": [f"{e.name} {e.sets}x{e.reps or str(e.duration_seconds) + 's'}" for e in s.exercises],
                }
                for s in plan.sessions
            ],
            "progression": plan.progression_notes or None,
            "replaces": current.title if current else None,
        },
    )
    if stop is not None:
        return stop
    with domain_span("firestore.save_plan", sessions=len(plan.sessions)):
        stored = await repo.save_current_plan(storage_user_id(tool_context), plan)
    return {"status": "saved", "plan_id": stored.plan_id, "title": stored.title}


async def get_current_training_plan(tool_context: ToolContext) -> dict[str, Any]:
    """Returns the user's current weekly training plan, if one is saved.

    Returns:
        ``{"status": "ok", "plan": {...}}`` or a guided error when there is no plan.
    """
    plan = await repository().get_current_plan(storage_user_id(tool_context))
    if plan is None:
        return tool_error("No training plan saved yet.", "Offer to create one with the workout planner.")
    return {"status": "ok", "plan": plan.model_dump(mode="json", exclude_none=True)}
