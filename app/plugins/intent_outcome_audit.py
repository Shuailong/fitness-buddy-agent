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

"""Runner-wide audit log of tool intent vs. outcome (NFR-B2).

For every tool call by any agent or sub-agent, two structured log entries are
written and correlated by ``call_id``:

* ``tool_intent``  - BEFORE execution: agent, tool, redacted arguments.
* ``tool_outcome`` - AFTER execution: status, latency, redacted result preview.

Unhandled tool exceptions are logged as ``tool_failure`` and converted into a
guided error for the LLM (NFR-T4) instead of crashing the run.
"""

import json
import logging
import time
from typing import Any

from google.adk.plugins.base_plugin import BasePlugin
from google.adk.tools import BaseTool, ToolContext
from opentelemetry import trace

from app.observability.pii_redaction import redact_text_async
from app.observability.structured_logging import log_event

_PREVIEW_CHARS = 600


def _preview(value: Any) -> str:
    try:
        text = json.dumps(value, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(value)
    return text[:_PREVIEW_CHARS]


def _outcome_status(result: Any) -> str:
    if isinstance(result, dict):
        return str(result.get("status") or ("error" if "error" in result else "ok"))
    return "ok"


class IntentOutcomeAuditPlugin(BasePlugin):
    """Logs what each agent intended to do and what actually happened."""

    def __init__(self) -> None:
        super().__init__(name="intent_outcome_audit")
        self._started: dict[str, float] = {}

    @staticmethod
    def _base_fields(tool: BaseTool, tool_context: ToolContext) -> dict[str, Any]:
        return {
            "agent": tool_context.agent_name,
            "tool": tool.name,
            "call_id": tool_context.function_call_id,
            "invocation_id": tool_context.invocation_id,
            "session_id": tool_context.session.id,
        }

    async def before_tool_callback(
        self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext
    ) -> dict | None:
        self._started[tool_context.function_call_id or ""] = time.monotonic()
        try:
            log_event(
                "tool_intent",
                **self._base_fields(tool, tool_context),
                args=await redact_text_async(_preview(tool_args)),
            )
            trace.get_current_span().add_event("tool_intent", {"tool": tool.name})
        except Exception:
            logging.getLogger(__name__).debug("intent logging failed", exc_info=True)
        return None

    async def after_tool_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: dict[str, Any],
        tool_context: ToolContext,
        result: dict,
    ) -> dict | None:
        started = self._started.pop(tool_context.function_call_id or "", None)
        status = _outcome_status(result)
        try:
            log_event(
                "tool_outcome",
                severity=logging.WARNING if status == "error" else logging.INFO,
                **self._base_fields(tool, tool_context),
                status=status,
                latency_ms=round((time.monotonic() - started) * 1000, 1) if started else None,
                result=await redact_text_async(_preview(result)),
            )
            trace.get_current_span().add_event("tool_outcome", {"tool": tool.name, "status": status})
        except Exception:
            logging.getLogger(__name__).debug("outcome logging failed", exc_info=True)
        return None

    async def on_tool_error_callback(
        self,
        *,
        tool: BaseTool,
        tool_args: dict[str, Any],
        tool_context: ToolContext,
        error: Exception,
    ) -> dict | None:
        self._started.pop(tool_context.function_call_id or "", None)
        log_event(
            "tool_failure",
            severity=logging.ERROR,
            **self._base_fields(tool, tool_context),
            error_type=type(error).__name__,
            error=await redact_text_async(str(error)[:_PREVIEW_CHARS]),
        )
        return {
            "status": "error",
            "error_message": f"The {tool.name} tool failed unexpectedly ({type(error).__name__}).",
            "recovery_hint": "Apologize briefly, do not claim success, and offer to retry or continue without it.",
        }
