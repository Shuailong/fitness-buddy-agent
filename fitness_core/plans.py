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

"""Exercise library lookups and deterministic training-plan validation (FR-3)."""

from __future__ import annotations

import functools
import json
import math
from collections.abc import Iterable
from datetime import date, timedelta
from pathlib import Path

from pydantic import BaseModel, Field

from fitness_core.models import (
    WEEKDAYS,
    Equipment,
    FitnessProfile,
    InjuryArea,
    PlanAdjustment,
    PlannedExercise,
    PlannedSession,
    TrainingPlan,
)

_LIBRARY_PATH = Path(__file__).parent / "data" / "exercise_library.json"
WARMUP_MINUTES = 5
SECONDS_PER_REP = 4
SET_TRANSITION_SECONDS = 15


class Exercise(BaseModel):
    """An exercise in the curated library."""

    id: str
    name: str
    category: str
    muscles: list[str]
    equipment: list[Equipment] = Field(
        description="All required equipment; empty = bodyweight."
    )
    contraindications: list[InjuryArea]


@functools.cache
def load_exercise_library() -> dict[str, Exercise]:
    """Loads the curated exercise catalog keyed by exercise ID."""
    raw = json.loads(_LIBRARY_PATH.read_text(encoding="utf-8"))
    return {e["id"]: Exercise.model_validate(e) for e in raw["exercises"]}


MUSCLE_ALIASES: dict[str, set[str]] = {
    "back": {"upper_back", "lats", "lower_back", "rear_delts"},
    "legs": {"quads", "hamstrings", "glutes", "calves"},
    "lower_body": {"quads", "hamstrings", "glutes", "calves"},
    "arms": {"biceps", "triceps"},
    "abs": {"core", "obliques"},
    "chest_and_triceps": {"chest", "triceps"},
    "delts": {"shoulders", "rear_delts"},
    "hips": {"hips", "hip_flexors", "glutes"},
}


def known_muscles() -> list[str]:
    """All muscle names used in the library plus supported aliases."""
    names = {m for ex in load_exercise_library().values() for m in ex.muscles}
    return sorted(names | set(MUSCLE_ALIASES))


def search_exercises(
    *,
    available_equipment: Iterable[str],
    injury_areas: Iterable[str] = (),
    muscle: str | None = None,
    category: str | None = None,
) -> list[Exercise]:
    """Returns library exercises the user can safely do with their equipment.

    Args:
        available_equipment: Equipment the user has. Bodyweight is always available.
        injury_areas: Injury areas; exercises contraindicated for any are excluded.
        muscle: Optional target muscle or group alias, e.g. ``glutes`` or ``back``.
        category: Optional category filter: strength, core, cardio, mobility.

    Returns:
        Matching exercises sorted by ID.
    """
    equipment = set(available_equipment) | {"bodyweight"}
    injuries = set(injury_areas)
    wanted: set[str] | None = None
    if muscle:
        key = muscle.strip().lower().replace(" ", "_")
        wanted = MUSCLE_ALIASES.get(key, {key})
    results = []
    for ex in load_exercise_library().values():
        if not set(ex.equipment) <= equipment:
            continue
        if injuries & set(ex.contraindications):
            continue
        if wanted is not None and not wanted & set(ex.muscles):
            continue
        if category and ex.category != category:
            continue
        results.append(ex)
    return sorted(results, key=lambda e: e.id)


def estimate_exercise_seconds(ex: PlannedExercise) -> int:
    """Estimates working plus rest time for one planned exercise."""
    work = (
        ex.duration_seconds
        if ex.duration_seconds
        else (ex.reps or 10) * SECONDS_PER_REP
    )
    return (
        ex.sets * (work + SET_TRANSITION_SECONDS)
        + max(ex.sets - 1, 0) * ex.rest_seconds
    )


def estimate_session_minutes(session: PlannedSession) -> int:
    """Estimates total session duration in minutes, including a warm-up."""
    seconds = sum(estimate_exercise_seconds(e) for e in session.exercises)
    return WARMUP_MINUTES + math.ceil(seconds / 60)


class PlanViolation(BaseModel):
    """One constraint the plan breaks, with a concrete fix."""

    rule: str
    day_of_week: str | None = None
    exercise_id: str | None = None
    message: str
    suggested_fix: str


class PlanValidationResult(BaseModel):
    """Outcome of deterministic plan validation."""

    is_valid: bool
    violations: list[PlanViolation]
    estimated_minutes_by_day: dict[str, int]


def validate_training_plan(
    plan: TrainingPlan, profile: FitnessProfile
) -> PlanValidationResult:
    """Checks a plan against the user's equipment, time limit, days and injuries.

    Args:
        plan: The candidate weekly plan.
        profile: The user's profile (equipment, minutes per session, injuries).

    Returns:
        Whether the plan is valid, every violation with a suggested fix, and the
        code-estimated duration of each session.
    """
    library = load_exercise_library()
    equipment = set(profile.equipment) | {"bodyweight"}
    injuries = set(profile.injury_areas)
    violations: list[PlanViolation] = []
    minutes_by_day: dict[str, int] = {}

    if len(plan.sessions) > profile.training_days_per_week:
        violations.append(
            PlanViolation(
                rule="too_many_sessions",
                message=f"Plan has {len(plan.sessions)} sessions but the user trains "
                f"{profile.training_days_per_week} days per week.",
                suggested_fix=f"Reduce the plan to {profile.training_days_per_week} sessions.",
            )
        )
    days = [s.day_of_week for s in plan.sessions]
    if len(days) != len(set(days)):
        violations.append(
            PlanViolation(
                rule="duplicate_day",
                message="More than one session is scheduled on the same day.",
                suggested_fix="Schedule each session on a different day.",
            )
        )

    for session in plan.sessions:
        minutes = estimate_session_minutes(session)
        minutes_by_day[session.day_of_week] = minutes
        if minutes > profile.minutes_per_session:
            violations.append(
                PlanViolation(
                    rule="session_too_long",
                    day_of_week=session.day_of_week,
                    message=f"Estimated {minutes} min exceeds the {profile.minutes_per_session} min limit.",
                    suggested_fix="Remove an exercise, cut sets, or shorten rest periods.",
                )
            )
        for ex in session.exercises:
            entry = library.get(ex.exercise_id)
            if entry is None:
                violations.append(
                    PlanViolation(
                        rule="unknown_exercise",
                        day_of_week=session.day_of_week,
                        exercise_id=ex.exercise_id,
                        message=f"'{ex.exercise_id}' is not in the exercise library.",
                        suggested_fix="Call search_exercise_library and use a returned exercise_id.",
                    )
                )
                continue
            missing = set(entry.equipment) - equipment
            if missing:
                violations.append(
                    PlanViolation(
                        rule="missing_equipment",
                        day_of_week=session.day_of_week,
                        exercise_id=ex.exercise_id,
                        message=f"{entry.name} needs {sorted(missing)}, which the user does not have.",
                        suggested_fix="Substitute an exercise for the same muscles using available equipment.",
                    )
                )
            conflicts = injuries & set(entry.contraindications)
            if conflicts:
                violations.append(
                    PlanViolation(
                        rule="injury_conflict",
                        day_of_week=session.day_of_week,
                        exercise_id=ex.exercise_id,
                        message=f"{entry.name} is contraindicated for {sorted(conflicts)}.",
                        suggested_fix="Substitute a joint-friendly exercise for the same muscles.",
                    )
                )

    return PlanValidationResult(
        is_valid=not violations,
        violations=violations,
        estimated_minutes_by_day=minutes_by_day,
    )


def week_dates(today: date) -> list[date]:
    """Monday..Sunday of the week that contains ``today``."""
    monday = today - timedelta(days=today.weekday())
    return [monday + timedelta(days=i) for i in range(7)]


def effective_session(
    plan: TrainingPlan | None,
    adjustments: Iterable[PlanAdjustment],
    on: date,
) -> tuple[PlannedSession | None, PlanAdjustment | None]:
    """The session planned for a calendar date, after one-off adjustments.

    Args:
        plan: The weekly plan (the template), if any.
        adjustments: One-off adjustments (any dates).
        on: The calendar date.

    Returns:
        ``(session, adjustment)``: the session to do on that date (None = rest)
        and the adjustment that changed it (None = weekly plan as-is).
    """
    iso = on.isoformat()
    adjustment = next((a for a in adjustments if a.local_date == iso), None)
    if adjustment is not None:
        return adjustment.session, adjustment
    weekday = WEEKDAYS[on.weekday()]
    template = (
        next((s for s in plan.sessions if s.day_of_week == weekday), None)
        if plan
        else None
    )
    return template, None


def effective_week(
    plan: TrainingPlan | None,
    adjustments: Iterable[PlanAdjustment],
    today: date,
) -> list[dict]:
    """This week's schedule (Monday..Sunday) with one-off adjustments applied.

    Returns:
        Seven JSON-ready dicts: ``date``, ``day_of_week``, ``session`` (or
        None for rest), ``adjusted``, ``reason`` and ``replaces_focus``.
    """
    adjustments = list(adjustments)
    days = []
    for d in week_dates(today):
        session, adjustment = effective_session(plan, adjustments, d)
        days.append(
            {
                "date": d.isoformat(),
                "day_of_week": WEEKDAYS[d.weekday()],
                "session": session.model_dump(mode="json") if session else None,
                "adjusted": adjustment is not None,
                "reason": adjustment.reason if adjustment else "",
                "replaces_focus": adjustment.replaces_focus if adjustment else None,
            }
        )
    return days
