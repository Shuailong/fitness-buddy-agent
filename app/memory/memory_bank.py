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

"""Background, PII-redacted long-term memory writes (NFR-C4, NFR-B4, FR-9).

After each coordinator turn, this turn's user/coach text is copied, scrubbed of
PII (regex + Cloud DLP), stripped of tool calls, tool results and images, and
sent to Memory Bank in a background task. The reply is never blocked by
redaction or memory generation; failures are logged, never raised.

Memories are recalled on later turns by ``PreloadMemoryTool`` on the
coordinator, scoped to ``(app_name, user_id)``.
"""

import asyncio
import logging

from google.adk.agents.callback_context import CallbackContext
from google.adk.events import Event
from google.genai import types

from app.observability.pii_redaction import redact_text_async
from app.observability.structured_logging import log_event

# Strong references so background tasks are not garbage-collected mid-flight.
_BACKGROUND_TASKS: set[asyncio.Task] = set()


async def _redacted_copy(event: Event) -> Event | None:
    """Returns a copy of ``event`` with only redacted text parts, or None."""
    if not event.content or not event.content.parts:
        return None
    texts = [p.text for p in event.content.parts if p.text and not p.thought]
    if not texts:
        return None
    redacted = [await redact_text_async(t) for t in texts]
    return event.model_copy(
        update={"content": types.Content(role=event.content.role, parts=[types.Part.from_text(text=t) for t in redacted])},
        deep=True,
    )


async def _ingest(memory_service, app_name: str, user_id: str, session_id: str, events: list[Event]) -> None:
    redacted = [e for e in [await _redacted_copy(ev) for ev in events] if e is not None]
    if not redacted:
        return
    await memory_service.add_events_to_memory(
        app_name=app_name, user_id=user_id, session_id=session_id, events=redacted
    )
    log_event("memory_ingest_submitted", events=len(redacted), session_id=session_id)


def _log_task_result(task: asyncio.Task) -> None:
    _BACKGROUND_TASKS.discard(task)
    if not task.cancelled() and task.exception() is not None:
        log_event("memory_ingest_failed", severity=logging.WARNING, error_type=type(task.exception()).__name__)


async def schedule_redacted_memory_ingest(callback_context: CallbackContext) -> None:
    """``after_agent_callback``: queue this turn for memory generation and return.

    Args:
        callback_context: The coordinator's callback context.
    """
    invocation = callback_context._invocation_context
    memory_service = invocation.memory_service
    if memory_service is None:
        return None
    session = invocation.session
    turn_events = [e for e in session.events if e.invocation_id == callback_context.invocation_id]
    if not turn_events:
        return None
    task = asyncio.create_task(
        _ingest(memory_service, session.app_name, session.user_id, session.id, turn_events),
        name=f"memory-ingest-{callback_context.invocation_id}",
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_log_task_result)
    return None
