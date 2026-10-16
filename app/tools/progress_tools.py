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

"""Weekly progress and in-session check-in tools (FR-7, FR-8)."""

from datetime import date, timedelta
from typing import Any

from google.adk.tools import ToolContext

from app.observability.tracing import domain_span
from app.tools._common import (
    load_profile,
    local_today,
    missing_profile_error,
    repository,
    storage_user_id,
    tool_error,
)
from fitness_core.models import utc_now
from fitness_core.progress import due_check_ins, weekly_progress_snapshot


async def get_weekly_progress_snapshot(
    tool_context: ToolContext, week_end: str | None = None
) -> dict[str, Any]:
    """Returns deterministic weekly aggregates for the 7 days ending on ``week_end``.

    Includes workout completion (done / planned), average daily calories vs.
    target, days the protein target was hit and the 7-day-average weight change.

    Args:
        week_end: Last day of the week, YYYY-MM-DD; omit for today.

    Returns:
        ``{"status": "ok", "snapshot": {...}, "targets": {...}}``.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return missing_profile_error()
    try:
        end = date.fromisoformat(week_end) if week_end else local_today(profile)
    except ValueError:
        return tool_error(
            f"'{week_end}' is not a valid date.", "Use YYYY-MM-DD or omit week_end."
        )
    repo = repository()
    start = (end - timedelta(days=60)).isoformat()
    with domain_span("weekly_snapshot"):
        snapshot = weekly_progress_snapshot(
            profile=profile,
            plan=await repo.get_current_plan(storage_user_id(tool_context)),
            workouts=await repo.list_workouts(
                storage_user_id(tool_context), start, end.isoformat()
            ),
            meals=await repo.list_meals(
                storage_user_id(tool_context), start, end.isoformat()
            ),
            measurements=await repo.list_measurements(storage_user_id(tool_context)),
            week_end=end,
        )
    return {
        "status": "ok",
        "snapshot": snapshot.model_dump(),
        "goal": profile.goal,
        "targets": profile.targets.model_dump() if profile.targets else None,
    }


async def list_due_check_ins(tool_context: ToolContext) -> dict[str, Any]:
    """Lists things to raise at the start of a conversation (max 3, never repeated).

    Covers planned workouts this week that were not logged, a due weigh-in and a
    due weekly review. Items returned here are marked as raised so they are not
    repeated in later conversations.

    Returns:
        ``{"status": "ok", "check_ins": [{key, kind, message}]}``; an empty list
        means there is nothing to raise.
    """
    profile = await load_profile(tool_context)
    if profile is None:
        return {
            "status": "ok",
            "check_ins": [],
            "note": "No profile yet: start onboarding.",
        }
    repo = repository()
    today = local_today(profile)
    state = await repo.get_check_in_state(storage_user_id(tool_context))
    latest_review = await repo.latest_weekly_review(storage_user_id(tool_context))
    monday = today - timedelta(days=today.weekday())
    with domain_span("due_check_ins"):
        items = due_check_ins(
            profile=profile,
            plan=await repo.get_current_plan(storage_user_id(tool_context)),
            workouts=await repo.list_workouts(
                storage_user_id(tool_context), monday.isoformat(), today.isoformat()
            ),
            measurements=await repo.list_measurements(storage_user_id(tool_context)),
            latest_review_date=date.fromisoformat(latest_review.week_end)
            if latest_review
            else None,
            state=state,
            today=today,
        )
    if items:
        state.raised_keys = (state.raised_keys + [i.key for i in items])[-200:]
        state.updated_at = utc_now()
        await repo.save_check_in_state(storage_user_id(tool_context), state)
    return {"status": "ok", "check_ins": [i.model_dump() for i in items]}
