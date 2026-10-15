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

"""Workout and body-measurement logging tools (FR-5, FR-6), plus deletion."""

from datetime import date, timedelta
from typing import Any

from google.adk.tools import ToolContext
from pydantic import ValidationError

from app.observability.tracing import domain_span
from app.tools._common import (
    confirmation_gate,
    load_profile,
    local_today,
    repository,
    storage_user_id,
    tool_error,
    validation_error,
)
from fitness_core.models import (
    WEEKDAYS,
    BodyMeasurement,
    PerceivedEffort,
    WorkoutSession,
    WorkoutSet,
    utc_now,
)
from fitness_core.repository import EntryKind, new_entry_id
from fitness_core.trends import weight_trend
from fitness_core.units import LengthUnit, WeightUnit, to_centimeters, to_kilograms


def _resolve_date(value: str | None, today: date) -> str | dict[str, Any]:
    if not value:
        return today.isoformat()
    try:
        day = date.fromisoformat(value)
    except ValueError:
        return tool_error(f"'{value}' is not a valid date.", "Use YYYY-MM-DD, or omit it for today.")
    if day > today:
        return tool_error("The date is in the future.", "Ask the user which day they meant.")
    return day.isoformat()


async def log_workout_session(
    exercises: list[WorkoutSet],
    tool_context: ToolContext,
    perceived_effort: PerceivedEffort | None = None,
    notes: str | None = None,
    session_date: str | None = None,
    load_unit: WeightUnit = "kg",
) -> dict[str, Any]:
    """Records a completed workout parsed from the user's sentence.

    Example: "Squat 60kg 5x5, felt tired" -> exercises=[{exercise_name: "Squat",
    sets: 5, reps: 5, weight_kg: 60}], perceived_effort="hard".

    Args:
        exercises: Each exercise with sets, reps and load (or duration for timed work).
            Put the load in ``weight_kg`` as stated; ``load_unit`` converts it.
        perceived_effort: How hard it felt: very_easy, easy, moderate, hard, very_hard.
        notes: Optional short note (feelings, pain, context).
        session_date: Date in YYYY-MM-DD; omit for today in the user's time zone.
        load_unit: Unit of the loads given in ``weight_kg`` (kg, lb or jin).

    Returns:
        The saved entry plus feedback facts: the planned session for that day,
        and any new personal records (heaviest load per exercise).
    """
    profile = await load_profile(tool_context)
    day = _resolve_date(session_date, local_today(profile))
    if isinstance(day, dict):
        return day
    try:
        normalized = [
            e.model_copy(update={"weight_kg": to_kilograms(e.weight_kg, load_unit)}) if e.weight_kg else e
            for e in exercises
        ]
        session = WorkoutSession(
            entry_id=new_entry_id(),
            user_id=storage_user_id(tool_context),
            local_date=day,
            performed_at=utc_now(),
            exercises=normalized,
            perceived_effort=perceived_effort,
            notes=notes,
        )
    except (ValidationError, ValueError) as exc:
        if isinstance(exc, ValidationError):
            return validation_error(exc, "workout")
        return tool_error(str(exc), "Ask the user to restate the load with a unit.")

    repo = repository()
    history = await repo.list_workouts(storage_user_id(tool_context))
    best: dict[str, float] = {}
    for past in history:
        for ex in past.exercises:
            if ex.weight_kg is not None:
                key = ex.exercise_name.strip().lower()
                best[key] = max(best.get(key, 0.0), ex.weight_kg)
    records = [
        {"exercise": ex.exercise_name, "weight_kg": ex.weight_kg, "previous_best_kg": best.get(ex.exercise_name.strip().lower())}
        for ex in normalized
        if ex.weight_kg is not None and ex.weight_kg > best.get(ex.exercise_name.strip().lower(), 0.0) and history
    ]
    with domain_span("firestore.add_workout", exercises=len(normalized)):
        await repo.add_entry(storage_user_id(tool_context), "workout", session)

    plan = await repo.get_current_plan(storage_user_id(tool_context))
    weekday = WEEKDAYS[date.fromisoformat(day).weekday()]
    planned = next((s for s in plan.sessions if s.day_of_week == weekday), None) if plan else None
    return {
        "status": "logged",
        "entry_id": session.entry_id,
        "local_date": day,
        "logged_exercises": [e.model_dump(exclude_none=True) for e in normalized],
        "planned_session_for_day": planned.model_dump(exclude_none=True) if planned else None,
        "new_personal_records": records,
    }


async def record_body_measurement(
    tool_context: ToolContext,
    weight_value: float | None = None,
    weight_unit: WeightUnit = "kg",
    body_fat_percent: float | None = None,
    waist_value: float | None = None,
    waist_unit: LengthUnit = "cm",
    measurement_date: str | None = None,
) -> dict[str, Any]:
    """Records body weight, body-fat percentage and/or waist circumference.

    Units are normalized (1 jin = 0.5 kg, 1 lb = 0.4536 kg, 1 in = 2.54 cm).
    At least one measurement must be provided.

    Args:
        weight_value: Body weight as stated by the user.
        weight_unit: Unit of ``weight_value``: kg, lb or jin.
        body_fat_percent: Body fat in percent (3-60).
        waist_value: Waist circumference as stated.
        waist_unit: Unit of ``waist_value``: cm, in or m.
        measurement_date: YYYY-MM-DD; omit for today.

    Returns:
        The saved entry and the updated weight trend (7-day average, change since
        start and versus last month).
    """
    if weight_value is None and body_fat_percent is None and waist_value is None:
        return tool_error("No measurement was provided.", "Ask the user for weight, body fat or waist.")
    profile = await load_profile(tool_context)
    day = _resolve_date(measurement_date, local_today(profile))
    if isinstance(day, dict):
        return day
    try:
        entry = BodyMeasurement(
            entry_id=new_entry_id(),
            user_id=storage_user_id(tool_context),
            local_date=day,
            measured_at=utc_now(),
            weight_kg=to_kilograms(weight_value, weight_unit) if weight_value is not None else None,
            body_fat_percent=body_fat_percent,
            waist_cm=to_centimeters(waist_value, waist_unit) if waist_value is not None else None,
        )
    except ValidationError as exc:
        return validation_error(exc, "measurement")
    except ValueError as exc:
        return tool_error(str(exc), "Ask the user to restate the value with a unit.")
    repo = repository()
    with domain_span("firestore.add_measurement"):
        await repo.add_entry(storage_user_id(tool_context), "measurement", entry)
    trend = weight_trend(
        await repo.list_measurements(storage_user_id(tool_context)),
        starting_weight_kg=profile.starting_weight_kg if profile else None,
    )
    return {
        "status": "recorded",
        "entry": entry.model_dump(mode="json", exclude={"user_id"}, exclude_none=True),
        "trend": trend.model_dump(exclude={"points"}),
    }


async def get_body_measurement_trend(tool_context: ToolContext) -> dict[str, Any]:
    """Returns the weight trend: 7-day moving average and comparisons.

    Returns:
        Latest weight, 7-day average, change since start and versus last month,
        latest body fat and waist, plus the last 30 daily points.
    """
    profile = await load_profile(tool_context)
    with domain_span("weight_trend"):
        trend = weight_trend(
            await repository().list_measurements(storage_user_id(tool_context)),
            starting_weight_kg=profile.starting_weight_kg if profile else None,
        )
    if not trend.points:
        return tool_error("No weight measurements yet.", "Invite the user to log today's weight.")
    data = trend.model_dump()
    data["points"] = data["points"][-30:]
    return {"status": "ok", "trend": data}


async def list_recent_log_entries(
    kind: EntryKind, tool_context: ToolContext, days: int = 7
) -> dict[str, Any]:
    """Lists recent workout, meal or measurement entries with their IDs.

    Use this to find the ``entry_id`` before correcting or deleting an entry.

    Args:
        kind: ``workout``, ``meal`` or ``measurement``.
        days: How many days back to look (1-60).

    Returns:
        Up to 20 entries, newest first, each with ``entry_id`` and ``local_date``.
    """
    days = max(1, min(days, 60))
    profile = await load_profile(tool_context)
    start = (local_today(profile) - timedelta(days=days - 1)).isoformat()
    repo = repository()
    lister = {"workout": repo.list_workouts, "meal": repo.list_meals, "measurement": repo.list_measurements}[kind]
    entries = await lister(storage_user_id(tool_context), start=start)
    return {
        "status": "ok",
        "entries": [e.model_dump(mode="json", exclude={"user_id"}, exclude_none=True) for e in reversed(entries)][:20],
    }


async def delete_logged_entry(
    kind: EntryKind, entry_id: str, reason: str, tool_context: ToolContext
) -> dict[str, Any]:
    """Permanently deletes a logged entry (requires user confirmation).

    Args:
        kind: ``workout``, ``meal`` or ``measurement``.
        entry_id: The entry ID from ``list_recent_log_entries``.
        reason: Why it should be deleted (shown to the user).

    Returns:
        ``status`` is ``deleted``, ``pending_confirmation``, ``rejected_by_user``
        or a guided error if the entry does not exist.
    """
    repo = repository()
    lister = {"workout": repo.list_workouts, "meal": repo.list_meals, "measurement": repo.list_measurements}[kind]
    match = next((e for e in await lister(storage_user_id(tool_context)) if e.entry_id == entry_id), None)
    if match is None:
        return tool_error(f"No {kind} entry with id '{entry_id}'.", "Call list_recent_log_entries to find the right entry_id.")
    stop = confirmation_gate(
        tool_context,
        action=f"delete_{kind}",
        title=f"Delete this {kind} entry?",
        summary=f"Delete the {kind} entry from {match.local_date}. This cannot be undone. Reason: {reason}",
        details=match.model_dump(mode="json", exclude={"user_id"}, exclude_none=True),
    )
    if stop is not None:
        return stop
    with domain_span("firestore.delete_entry", kind=kind):
        deleted = await repo.delete_entry(storage_user_id(tool_context), kind, entry_id)
    return {"status": "deleted" if deleted else "already_deleted", "entry_id": entry_id}
