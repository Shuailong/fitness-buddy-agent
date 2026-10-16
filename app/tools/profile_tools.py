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

"""Profile and energy-target tools (FR-1, FR-2)."""

from typing import Any

from google.adk.tools import ToolContext
from pydantic import ValidationError

from app.observability.tracing import domain_span
from app.schemas import FitnessProfileInput
from app.tools._common import (
    confirmation_gate,
    load_profile,
    missing_profile_error,
    repository,
    storage_user_id,
    tool_error,
    validation_error,
)
from fitness_core.energy import calculate_energy_targets
from fitness_core.models import FitnessProfile, utc_now
from fitness_core.trends import weight_trend
from fitness_core.units import to_centimeters, to_kilograms


async def _current_weight_kg(profile: FitnessProfile) -> float:
    measurements = await repository().list_measurements(profile.user_id)
    trend = weight_trend(measurements, starting_weight_kg=profile.starting_weight_kg)
    return trend.latest_moving_average_kg or profile.starting_weight_kg


async def get_fitness_profile(tool_context: ToolContext) -> dict[str, Any]:
    """Returns the user's saved fitness profile and current daily targets.

    Use this before planning, logging or advising so answers respect the user's
    goal, equipment, injuries, diet and targets.

    Returns:
        ``{"status": "ok", "profile": {...}}`` or a guided error when the user
        has not completed onboarding.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    return {"status": "ok", "profile": profile.model_dump(mode="json", exclude={"user_id"})}


async def save_fitness_profile(profile: FitnessProfileInput, tool_context: ToolContext) -> dict[str, Any]:
    """Creates or updates the user's fitness profile and computes daily targets.

    Converts units to metric (kg, cm; 1 jin = 0.5 kg), validates ranges, computes
    calorie and macro targets in code (Mifflin-St Jeor + safety clamps) and saves
    everything. Call it once onboarding answers are complete, or when the user
    changes goal, schedule, equipment, injuries or diet.

    Args:
        profile: The onboarding answers. Ask the user for any required field you
            do not know instead of guessing.

    Returns:
        ``{"status": "saved", "targets": {...}, "profile": {...}}`` or a guided error.
    """
    try:
        height_cm = to_centimeters(profile.height_value, profile.height_unit)
        weight_kg = to_kilograms(profile.weight_value, profile.weight_unit)
        waist_cm = to_centimeters(profile.waist_value, profile.waist_unit) if profile.waist_value else None
    except ValueError as exc:
        return tool_error(str(exc), "Ask the user to restate the value with a unit (kg, lb, jin, cm, in).")

    existing = await load_profile(tool_context)
    with domain_span("energy_targets", goal=profile.goal, training_days=profile.training_days_per_week):
        targets = calculate_energy_targets(
            sex=profile.sex,
            age=profile.age,
            height_cm=height_cm,
            weight_kg=weight_kg,
            training_days_per_week=profile.training_days_per_week,
            goal=profile.goal,
        )
    try:
        saved = FitnessProfile(
            user_id=storage_user_id(tool_context),
            goal=profile.goal,
            sex=profile.sex,
            age=profile.age,
            height_cm=height_cm,
            starting_weight_kg=existing.starting_weight_kg if existing else weight_kg,
            body_fat_percent=profile.body_fat_percent,
            waist_cm=waist_cm,
            training_days_per_week=profile.training_days_per_week,
            minutes_per_session=profile.minutes_per_session,
            preferred_training_days=profile.preferred_training_days,
            equipment=profile.equipment,
            dietary_preferences=profile.dietary_preferences,
            allergies=profile.allergies,
            injuries=profile.injuries,
            injury_areas=profile.injury_areas,
            timezone=profile.timezone,
            targets=targets,
            created_at=existing.created_at if existing else utc_now(),
            updated_at=utc_now(),
        )
    except ValidationError as exc:
        return validation_error(exc, "profile")

    # Changing the calorie target of an existing profile is a high-stakes write
    # (NFR-O4), even when it is a side effect of a profile edit such as fewer
    # training days. First-time onboarding is not gated.
    old_targets = existing.targets if existing else None
    if old_targets and old_targets.daily_calories_kcal != targets.daily_calories_kcal:
        stop = confirmation_gate(
            tool_context,
            action="update_calorie_target",
            title="Update your profile and daily calorie target?",
            summary=(
                f"Daily target {old_targets.daily_calories_kcal} → "
                f"{targets.daily_calories_kcal} kcal because your profile changed "
                f"(goal {profile.goal}, {profile.training_days_per_week} training days/week)."
            ),
            details={
                "current_kcal": old_targets.daily_calories_kcal,
                "new_kcal": targets.daily_calories_kcal,
                "protein_g": targets.protein_g,
                "carbs_g": targets.carbs_g,
                "fat_g": targets.fat_g,
                "clamp_reasons": targets.clamp_reasons,
            },
        )
        if stop is not None:
            return stop

    with domain_span("firestore.save_profile"):
        await repository().save_profile(saved)
    minor_note = (
        "User is under 18: recommend involving a parent, doctor or qualified coach."
        if profile.age < 18
        else None
    )
    return {
        "status": "saved",
        "targets": targets.model_dump(),
        "profile": saved.model_dump(mode="json", exclude={"user_id", "targets"}),
        "advisory": minor_note,
    }


async def calculate_daily_energy_targets(
    tool_context: ToolContext, requested_daily_calories_kcal: int | None = None
) -> dict[str, Any]:
    """Previews daily calorie and macro targets without saving anything.

    Uses the saved profile and the latest 7-day average weight. Pass a requested
    calorie value to check whether it is safe: the result shows the clamped value
    and which safety rule applied (calorie floor, 1%/week loss limit, surplus cap).

    Args:
        requested_daily_calories_kcal: Optional calorie target to evaluate.

    Returns:
        ``{"status": "ok", "targets": {...}, "weight_used_kg": float}``.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    weight = await _current_weight_kg(profile)
    with domain_span("energy_targets", goal=profile.goal, preview=True):
        targets = calculate_energy_targets(
            sex=profile.sex,
            age=profile.age,
            height_cm=profile.height_cm,
            weight_kg=weight,
            training_days_per_week=profile.training_days_per_week,
            goal=profile.goal,
            requested_daily_calories_kcal=requested_daily_calories_kcal,
        )
    return {"status": "ok", "targets": targets.model_dump(), "weight_used_kg": weight}


async def update_daily_calorie_target(
    daily_calories_kcal: int, reason: str, tool_context: ToolContext
) -> dict[str, Any]:
    """Changes the user's daily calorie target (requires user confirmation).

    The value is clamped by the safety rules before it is shown to the user, and
    the change is only saved after the user clicks Confirm. Macros are
    recomputed from the new calorie target.

    Args:
        daily_calories_kcal: The proposed daily calorie target in kcal.
        reason: Why the change is proposed, e.g. a weekly review finding.

    Returns:
        ``status`` is ``updated``, ``pending_confirmation`` or ``rejected_by_user``.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    if not 800 <= daily_calories_kcal <= 6000:
        return tool_error(
            f"{daily_calories_kcal} kcal is outside the plausible range 800-6000.",
            "Re-check the number with the user; propose a realistic target.",
        )
    weight = await _current_weight_kg(profile)
    new_targets = calculate_energy_targets(
        sex=profile.sex,
        age=profile.age,
        height_cm=profile.height_cm,
        weight_kg=weight,
        training_days_per_week=profile.training_days_per_week,
        goal=profile.goal,
        requested_daily_calories_kcal=daily_calories_kcal,
    )
    old = profile.targets.daily_calories_kcal if profile.targets else None
    clamp_note = f" (adjusted for safety: {', '.join(new_targets.clamp_reasons)})" if new_targets.clamped else ""
    stop = confirmation_gate(
        tool_context,
        action="update_calorie_target",
        title="Change your daily calorie target?",
        summary=f"Daily target {old} → {new_targets.daily_calories_kcal} kcal{clamp_note}. Reason: {reason}",
        details={
            "current_kcal": old,
            "new_kcal": new_targets.daily_calories_kcal,
            "protein_g": new_targets.protein_g,
            "carbs_g": new_targets.carbs_g,
            "fat_g": new_targets.fat_g,
            "clamp_reasons": new_targets.clamp_reasons,
        },
    )
    if stop is not None:
        return stop
    updated = profile.model_copy(update={"targets": new_targets, "updated_at": utc_now()})
    with domain_span("firestore.save_profile", reason="calorie_target_update"):
        await repository().save_profile(updated)
    return {"status": "updated", "previous_kcal": old, "targets": new_targets.model_dump()}
