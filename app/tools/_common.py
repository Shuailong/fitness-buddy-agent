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

"""Shared helpers for agent tools: guided errors, confirmation gates, context."""

from __future__ import annotations

import os
from datetime import date
from typing import Any

from google.adk.tools import ToolContext
from pydantic import ValidationError

from fitness_core.models import FitnessProfile
from fitness_core.progress import user_local_date
from fitness_core.repository import FitnessRepository, get_repository


def tool_error(error_message: str, recovery_hint: str, **details: Any) -> dict[str, Any]:
    """Builds a guided error result for the LLM instead of raising (NFR-T4).

    Args:
        error_message: What went wrong, in plain language.
        recovery_hint: The concrete next step the agent should take to recover.
        **details: Extra structured context (e.g. offending fields).

    Returns:
        A dict with ``status='error'``, the message, the hint and details.
    """
    return {"status": "error", "error_message": error_message, "recovery_hint": recovery_hint, **details}


def validation_error(exc: ValidationError, what: str) -> dict[str, Any]:
    """Turns a Pydantic validation error into a guided error with field-level detail."""
    problems = [
        f"{'.'.join(str(p) for p in err['loc']) or what}: {err['msg']}" for err in exc.errors()[:8]
    ]
    return tool_error(
        f"Invalid {what}: " + "; ".join(problems),
        "Check the listed fields against the tool schema. If a value came from the user "
        "and looks wrong (e.g. unit confusion), ask the user to confirm it before retrying.",
        invalid_fields=problems,
    )


def repository() -> FitnessRepository:
    """Returns the configured fitness data repository."""
    return get_repository()


def storage_user_id(tool_context: ToolContext) -> str:
    """The key under which this user's data is stored.

    Normally the ADK user ID (the Google account ``sub`` from web sign-in). With
    ``FITNESS_EVAL_ISOLATION=true`` (eval runs, where every case shares one CLI
    user), data is keyed per session so cases cannot leak into each other.
    """
    if os.getenv("FITNESS_EVAL_ISOLATION", "").lower() == "true":
        return f"{tool_context.user_id}--{tool_context.session.id}"
    return tool_context.user_id


async def load_profile(tool_context: ToolContext) -> FitnessProfile | None:
    """Loads the current user's profile, scoped by the storage user ID."""
    return await repository().get_profile(storage_user_id(tool_context))


def missing_profile_error() -> dict[str, Any]:
    """Guided error used when a tool needs a profile that does not exist yet."""
    return tool_error(
        "This user has no fitness profile yet.",
        "Run onboarding first: collect goal, sex, age, height, weight, training days, "
        "minutes per session and equipment, then call save_fitness_profile.",
    )


def local_today(profile: FitnessProfile | None) -> date:
    """Today's date in the user's time zone (UTC when unknown)."""
    return user_local_date(profile.timezone if profile else "UTC")


def confirmation_gate(
    tool_context: ToolContext,
    *,
    action: str,
    title: str,
    summary: str,
    details: dict[str, Any],
) -> dict[str, Any] | None:
    """Human-in-the-loop stop before a high-stakes write (NFR-O4).

    On the first call this pauses the run and asks the end user to confirm via an
    ``adk_request_confirmation`` event (rendered as a Confirm / Reject card in the
    web app). When the run resumes, the tool is called again with the user's
    decision attached to ``tool_context.tool_confirmation``.

    Args:
        tool_context: The ADK tool context.
        action: Machine-readable action kind, e.g. ``replace_training_plan``.
        title: Short card title.
        summary: One-paragraph human-readable description of the change.
        details: Structured details rendered on the card.

    Returns:
        None when the user confirmed (the caller should proceed). Otherwise a
        result dict to return immediately (pending or rejected).
    """
    decision = tool_context.tool_confirmation
    if decision is None:
        tool_context.request_confirmation(
            hint=summary,
            payload={"kind": action, "title": title, "summary": summary, "details": details},
        )
        tool_context.actions.skip_summarization = True
        return {
            "status": "pending_confirmation",
            "message": "Waiting for the user to confirm or reject this change. Nothing has been saved yet.",
        }
    if not decision.confirmed:
        return {
            "status": "rejected_by_user",
            "message": "The user rejected this change. Nothing was saved.",
            "recovery_hint": "Acknowledge the decision, ask what they would like changed, and offer an alternative.",
        }
    return None
