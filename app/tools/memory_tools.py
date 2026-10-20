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

"""Coach Memory tools: save / forget durable user facts across conversations."""

from __future__ import annotations

from typing import Any, Literal

from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_request import LlmRequest
from google.adk.tools import ToolContext

from app.observability.pii_redaction import redact_text
from app.tools._common import repository, storage_user_id, tool_error
from fitness_core.memories import memories_prompt, remember

_PROMPT_STATE_KEY = "temp:coach_memory_prompt"


async def remember_user_fact(
    fact: str,
    category: Literal[
        "preference", "goal", "schedule", "training", "nutrition", "health", "other"
    ],
    tool_context: ToolContext,
    replaces_memory_id: str | None = None,
) -> dict[str, Any]:
    """Saves a durable fact about the user to Coach Memory (visible in Settings).

    Use for stable information worth knowing next week too: likes/dislikes
    (foods, exercises), schedule and routine, home equipment, coaching-style
    preferences, long-term goals and motivation, allergies or injuries the user
    explicitly asked you to remember. Do NOT save one-off events (today's meal),
    numbers already stored in the profile/logs, or sensitive health history the
    user did not ask you to keep.

    Args:
        fact: One short third-person sentence in the user's language, e.g.
            "Prefers 6:30am workouts on weekdays" or "不吃香菜".
        category: preference | goal | schedule | training | nutrition | health | other.
        replaces_memory_id: ID of an outdated memory this fact replaces
            (from the Coach Memory list), when the user's situation changed.

    Returns:
        ``{"status": "saved" | "updated" | "duplicate", "memory": {...}}`` or a guided error.
    """
    result = await remember(
        repository(),
        storage_user_id(tool_context),
        redact_text(fact),
        category=category,
        source="coach",
        replaces_memory_id=replaces_memory_id,
    )
    if result.get("status") == "error":
        return tool_error(
            result["error_message"],
            result.get(
                "recovery_hint",
                "Check the memory ID in the Coach Memory list and retry.",
            ),
        )
    tool_context.state[_PROMPT_STATE_KEY] = None  # refresh on the next model call
    return result


async def forget_user_fact(memory_id: str, tool_context: ToolContext) -> dict[str, Any]:
    """Deletes a Coach Memory entry, e.g. when the user says "forget that" or it is no longer true.

    Args:
        memory_id: The ID shown in brackets in the Coach Memory list.

    Returns:
        ``{"status": "forgotten"}`` or a guided error when the ID is unknown.
    """
    ok = await repository().delete_memory(storage_user_id(tool_context), memory_id)
    if not ok:
        return tool_error(
            f"No memory with id {memory_id}.",
            "Use an ID from the Coach Memory list in your instructions.",
        )
    tool_context.state[_PROMPT_STATE_KEY] = None
    return {"status": "forgotten", "memory_id": memory_id}


async def inject_coach_memory(
    callback_context: CallbackContext, llm_request: LlmRequest
) -> None:
    """``before_model_callback``: adds the user's Coach Memory to the system instruction.

    Loaded once per invocation (cached in ``temp:`` state) so multi-step turns
    do not re-read storage on every model call.
    """
    prompt = callback_context.state.get(_PROMPT_STATE_KEY)
    if prompt is None:
        try:
            memories = await repository().list_memories(
                storage_user_id(callback_context)
            )
        except Exception:  # never block a reply on memory storage
            memories = []
        prompt = memories_prompt(memories)
        callback_context.state[_PROMPT_STATE_KEY] = prompt
    if prompt:
        llm_request.append_instructions([prompt])
    return None
