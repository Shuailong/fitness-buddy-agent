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

from datetime import date, timedelta
from typing import Any, Literal

from google.adk.tools import ToolContext

from app.observability.tracing import domain_span
from app.tools._common import (
    confirmation_gate,
    load_profile,
    local_today,
    missing_profile_error,
    repository,
    storage_user_id,
    tool_error,
)
from fitness_core.models import (
    WEEKDAYS,
    PlanAdjustment,
    PlannedExercise,
    PlannedSession,
    TrainingPlan,
    Weekday,
)
from fitness_core.plans import (
    effective_session,
    effective_week,
    estimate_session_minutes,
    known_muscles,
    search_exercises,
    validate_training_plan,
    week_dates,
)

# One-off day adjustments reach at most this many days ahead.
ADJUST_HORIZON_DAYS = 13


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


async def validate_training_plan_constraints(
    plan: TrainingPlan, tool_context: ToolContext
) -> dict[str, Any]:
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


async def save_weekly_training_plan(
    plan: TrainingPlan, tool_context: ToolContext
) -> dict[str, Any]:
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
        title="Replace your current training plan?"
        if current
        else "Save this training plan?",
        summary=f"{plan.title}: {overview}"
        + (f". This replaces '{current.title}'." if current else "."),
        details={
            "title": plan.title,
            "sessions": [
                {
                    "day": s.day_of_week,
                    "focus": s.focus,
                    "minutes": result.estimated_minutes_by_day[s.day_of_week],
                    "exercises": [
                        f"{e.name} {e.sets}x{e.reps or str(e.duration_seconds) + 's'}"
                        for e in s.exercises
                    ],
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
    """Returns the user's weekly training plan and this week's actual schedule.

    Returns:
        ``plan`` (the weekly template), ``today`` (date and weekday in the
        user's time zone), ``this_week`` (Monday..Sunday with one-off
        adjustments applied; ``adjusted`` marks changed days) and
        ``upcoming_adjustments``. A guided error when there is no plan.
    """
    user_key = storage_user_id(tool_context)
    repo = repository()
    plan = await repo.get_current_plan(user_key)
    if plan is None:
        return tool_error(
            "No training plan saved yet.",
            "Offer to create one with the workout planner.",
        )
    profile = await load_profile(tool_context)
    today = local_today(profile)
    days = week_dates(today)
    adjustments = await repo.list_plan_adjustments(
        user_key,
        start=days[0].isoformat(),
        end=(today + timedelta(days=ADJUST_HORIZON_DAYS)).isoformat(),
    )
    this_week = [
        {
            "date": d["date"],
            "day_of_week": d["day_of_week"],
            "focus": d["session"]["focus"] if d["session"] else "rest",
            **({"adjusted": True, "reason": d["reason"]} if d["adjusted"] else {}),
        }
        for d in effective_week(plan, adjustments, today)
    ]
    return {
        "status": "ok",
        "today": {"date": today.isoformat(), "weekday": WEEKDAYS[today.weekday()]},
        "plan": plan.model_dump(mode="json", exclude_none=True),
        "this_week": this_week,
        "upcoming_adjustments": [
            a.model_dump(mode="json", exclude_none=True, exclude={"created_at"})
            for a in adjustments
            if a.local_date >= today.isoformat()
        ],
    }


def _resolve_plan_date(value: str, today: date) -> date | dict[str, Any]:
    """Parses ``today``/``tomorrow``/a weekday name/``YYYY-MM-DD`` into a date."""
    text = (value or "").strip().lower()
    if text in ("", "today", "今天"):
        day = today
    elif text in ("tomorrow", "明天"):
        day = today + timedelta(days=1)
    elif text in WEEKDAYS:
        day = today + timedelta(days=(WEEKDAYS.index(text) - today.weekday()) % 7)
    else:
        try:
            day = date.fromisoformat(text)
        except ValueError:
            return tool_error(
                f"'{value}' is not a valid date.",
                "Use YYYY-MM-DD, 'today', 'tomorrow' or a weekday name.",
            )
    if not today <= day <= today + timedelta(days=ADJUST_HORIZON_DAYS):
        return tool_error(
            f"{day.isoformat()} is outside the next {ADJUST_HORIZON_DAYS} days.",
            "One-off adjustments are for today or the coming two weeks. For a "
            "lasting change use update_weekly_plan_day or the workout planner.",
        )
    return day


def _violations_error(violations: list[Any]) -> dict[str, Any]:
    return tool_error(
        "The session violates the user's constraints and was not saved.",
        "Apply each suggested_fix (use search_exercise_library for substitutes), then call again.",
        violations=[v.model_dump(exclude_none=True) for v in violations],
    )


async def adjust_planned_day(
    tool_context: ToolContext,
    day: str = "today",
    exercises: list[PlannedExercise] | None = None,
    focus: str | None = None,
    rest_day: bool = False,
    reason: str = "",
) -> dict[str, Any]:
    """Changes the workout for ONE date only (the weekly plan stays as it is).

    Use it when the user wants to change today's (or another upcoming day's)
    session: swap or drop exercises, a shorter or home-only workout, a light
    recovery / mobility day, a rest day, or moving a workout to another day
    (call it twice: the old date as rest_day, the new date with the session).
    Saved immediately and shown on the Plan and Today pages.

    Args:
        day: "today", "tomorrow", a weekday name (next occurrence) or YYYY-MM-DD,
            within the next 14 days.
        exercises: The FULL list of exercises for that day (not only the changed
            one). Only use exercise_id values from search_exercise_library or
            from the current plan. Omit when rest_day is true.
        focus: Short session title, e.g. "Home upper body (20 min)". Defaults to
            the weekly plan's focus for that day.
        rest_day: True to make that date a rest day.
        reason: Short reason in the user's language, e.g. "only 20 min at home today".

    Returns:
        ``status: saved`` with the date, the new session (minutes estimated in
        code) and the session it replaces, or a guided error with violations.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    today = local_today(profile)
    when = _resolve_plan_date(day, today)
    if isinstance(when, dict):
        return when
    user_key = storage_user_id(tool_context)
    repo = repository()
    plan = await repo.get_current_plan(user_key)
    template, _ = effective_session(plan, [], when)
    weekday = WEEKDAYS[when.weekday()]
    session: PlannedSession | None = None
    if not rest_day:
        if not exercises:
            return tool_error(
                "No exercises given.",
                "Pass the full exercise list for that day, or rest_day=true.",
            )
        draft = PlannedSession(
            day_of_week=weekday,
            focus=(focus or (template.focus if template else "Training"))[:60],
            exercises=exercises,
            estimated_minutes=60,
        )
        session = draft.model_copy(
            update={"estimated_minutes": max(5, estimate_session_minutes(draft))}
        )
        check = validate_training_plan(
            TrainingPlan(title="Adjustment", goal=profile.goal, sessions=[session]),
            profile,
        )
        if not check.is_valid:
            return _violations_error(check.violations)
    adjustment = PlanAdjustment(
        local_date=when.isoformat(),
        day_of_week=weekday,
        session=session,
        reason=reason.strip()[:200],
        replaces_focus=template.focus if template else None,
    )
    with domain_span("firestore.save_plan_adjustment", rest_day=rest_day):
        await repo.save_plan_adjustment(user_key, adjustment)
    return {
        "status": "saved",
        "date": when.isoformat(),
        "day_of_week": weekday,
        "is_today": when == today,
        "rest_day": session is None,
        "session": session.model_dump(mode="json", exclude_none=True)
        if session
        else None,
        "replaces": template.model_dump(mode="json", exclude_none=True)
        if template
        else None,
        "note": "Now shown on the Plan and Today pages. The weekly plan is "
        "unchanged; clear_planned_day_adjustment undoes it.",
    }


async def clear_planned_day_adjustment(
    tool_context: ToolContext, day: str = "today"
) -> dict[str, Any]:
    """Undoes a one-off day adjustment so that date follows the weekly plan again.

    Args:
        day: "today", "tomorrow", a weekday name or YYYY-MM-DD.

    Returns:
        ``status: cleared`` (or ``nothing_to_clear``) and the session that
        applies on that date now.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    when = _resolve_plan_date(day, local_today(profile))
    if isinstance(when, dict):
        return when
    user_key = storage_user_id(tool_context)
    repo = repository()
    removed = await repo.delete_plan_adjustment(user_key, when.isoformat())
    template, _ = effective_session(await repo.get_current_plan(user_key), [], when)
    return {
        "status": "cleared" if removed else "nothing_to_clear",
        "date": when.isoformat(),
        "session_now": template.model_dump(mode="json", exclude_none=True)
        if template
        else "rest",
    }


async def update_weekly_plan_day(
    day_of_week: Weekday,
    tool_context: ToolContext,
    exercises: list[PlannedExercise] | None = None,
    focus: str | None = None,
    remove_session: bool = False,
) -> dict[str, Any]:
    """Permanently changes ONE weekday of the weekly plan (requires confirmation).

    Use it when the user wants a lasting change to a single day ("from now on
    swap planks for dead bugs on Tuesdays", "drop Friday"). For a one-off
    change use adjust_planned_day; for a redesign of the week, the planner.

    Args:
        day_of_week: monday..sunday.
        exercises: The FULL new exercise list for that weekday (exercise_id
            values from search_exercise_library or the current plan).
        focus: Session title; defaults to the current focus of that day.
        remove_session: True to turn that weekday into a rest day.

    Returns:
        ``saved``, ``pending_confirmation``, ``rejected_by_user`` or a guided
        error listing violations.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    user_key = storage_user_id(tool_context)
    repo = repository()
    plan = await repo.get_current_plan(user_key)
    if plan is None:
        return tool_error(
            "No training plan saved yet.",
            "Offer to create one with the workout planner.",
        )
    current = next((s for s in plan.sessions if s.day_of_week == day_of_week), None)
    others = [s for s in plan.sessions if s.day_of_week != day_of_week]
    new_session: PlannedSession | None = None
    if not remove_session:
        if not exercises:
            return tool_error(
                "No exercises given.",
                "Pass the full exercise list for that weekday, or remove_session=true.",
            )
        draft = PlannedSession(
            day_of_week=day_of_week,
            focus=(focus or (current.focus if current else "Training"))[:60],
            exercises=exercises,
            estimated_minutes=60,
        )
        new_session = draft.model_copy(
            update={"estimated_minutes": max(5, estimate_session_minutes(draft))}
        )
    sessions = sorted(
        others + ([new_session] if new_session else []),
        key=lambda s: WEEKDAYS.index(s.day_of_week),
    )
    if not sessions:
        return tool_error(
            "A plan needs at least one session.",
            "Keep at least one training day, or ask the planner for a new plan.",
        )
    updated = plan.model_copy(update={"sessions": sessions, "plan_id": None})
    check = validate_training_plan(updated, profile)
    if not check.is_valid:
        return _violations_error(check.violations)
    day_title = day_of_week.title()
    if new_session:
        summary = (
            f"Every {day_title}: {new_session.focus} (~{new_session.estimated_minutes} min)"
            + (f", instead of {current.focus}" if current else "")
            + ". Other days stay the same."
        )
    else:
        summary = f"Every {day_title} becomes a rest day. Other days stay the same."
    stop = confirmation_gate(
        tool_context,
        action="update_plan_day",
        title=f"Update every {day_title} in your plan?",
        summary=summary,
        details={
            "title": plan.title,
            "sessions": [
                {
                    "day": day_of_week,
                    "focus": new_session.focus if new_session else "Rest",
                    "minutes": new_session.estimated_minutes if new_session else 0,
                    "exercises": [
                        f"{e.name} {e.sets}x{e.reps or str(e.duration_seconds) + 's'}"
                        for e in (new_session.exercises if new_session else [])
                    ],
                }
            ],
            "replaces": current.focus if current else None,
        },
    )
    if stop is not None:
        return stop
    with domain_span("firestore.save_plan", sessions=len(sessions)):
        stored = await repo.save_current_plan(user_key, updated)
    return {
        "status": "saved",
        "plan_id": stored.plan_id,
        "day_of_week": day_of_week,
        "session": new_session.model_dump(mode="json", exclude_none=True)
        if new_session
        else "rest",
    }
