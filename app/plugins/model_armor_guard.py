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

"""Model Armor guardrail for prompt injection, jailbreaks and harmful content (NFR-O3, SR-7).

Adapted from the ADK ``safety-plugins`` recipe, with three fixes: all text parts
are screened (not only the first), calls run off the event loop, and Model
Armor uses its own regional location (Gemini runs on ``global``).

* ``on_user_message_callback``: screens the user's text. A flagged prompt is
  replaced with a placeholder BEFORE it is persisted (no session poisoning)
  and ``before_run_callback`` ends the turn with a refusal.
* ``after_model_callback``: screens final model text, which includes text the
  nutrition coach read from photos or menus.

The template is provisioned by Terraform (``deployment/terraform``).
"""

import asyncio
import logging

from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.invocation_context import InvocationContext
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins.base_plugin import BasePlugin
from google.genai import types

from app.config import SETTINGS
from app.observability.structured_logging import log_event

_FLAG_KEY = "temp:model_armor_blocked"
_BLOCKED_PROMPT = "[Message removed by safety filter]"
_REFUSAL = (
    "Sorry, I can't help with that request. I'm here for training, nutrition and "
    "progress tracking - what would you like to work on?"
)
_BLOCKED_REPLY = "Sorry, I can't share that response. Let's get back to your training and nutrition."


def _flagged_filters(response) -> list[str]:
    """Returns the names of Model Armor filters that matched."""
    from google.cloud import modelarmor_v1

    result = response.sanitization_result
    if result.filter_match_state != modelarmor_v1.FilterMatchState.MATCH_FOUND:
        return []
    return [name for name, fr in result.filter_results.items() if "MATCH_FOUND" in str(fr)] or ["unknown"]


class ModelArmorGuardPlugin(BasePlugin):
    """Screens user prompts and model responses with a Model Armor template."""

    def __init__(self) -> None:
        super().__init__(name="model_armor_guard")
        from google.api_core.client_options import ClientOptions
        from google.cloud import modelarmor_v1

        self._types = modelarmor_v1
        self._template = (
            f"projects/{SETTINGS.project_id}/locations/{SETTINGS.model_armor_location}"
            f"/templates/{SETTINGS.model_armor_template_id}"
        )
        self._client = modelarmor_v1.ModelArmorClient(
            client_options=ClientOptions(api_endpoint=f"modelarmor.{SETTINGS.model_armor_location}.rep.googleapis.com")
        )

    async def _screen(self, text: str, *, is_prompt: bool) -> list[str]:
        try:
            if is_prompt:
                request = self._types.SanitizeUserPromptRequest(
                    name=self._template, user_prompt_data=self._types.DataItem(text=text)
                )
                response = await asyncio.to_thread(self._client.sanitize_user_prompt, request=request)
            else:
                request = self._types.SanitizeModelResponseRequest(
                    name=self._template, model_response_data=self._types.DataItem(text=text)
                )
                response = await asyncio.to_thread(self._client.sanitize_model_response, request=request)
            return _flagged_filters(response)
        except Exception as exc:
            log_event("model_armor_error", severity=logging.WARNING, error_type=type(exc).__name__)
            return []

    async def on_user_message_callback(
        self, *, invocation_context: InvocationContext, user_message: types.Content
    ) -> types.Content | None:
        text = "\n".join(p.text for p in (user_message.parts or []) if p.text)
        if not text.strip():
            return None
        filters = await self._screen(text, is_prompt=True)
        if not filters:
            return None
        invocation_context.session.state[_FLAG_KEY] = True
        log_event("model_armor_prompt_blocked", severity=logging.WARNING, filters=filters,
                  session_id=invocation_context.session.id)
        # Keep non-text parts out as well: the whole message is replaced.
        return types.Content(role="user", parts=[types.Part.from_text(text=_BLOCKED_PROMPT)])

    async def before_run_callback(self, *, invocation_context: InvocationContext) -> types.Content | None:
        if invocation_context.session.state.get(_FLAG_KEY):
            invocation_context.session.state[_FLAG_KEY] = False
            return types.Content(role="model", parts=[types.Part.from_text(text=_REFUSAL)])
        return None

    async def after_model_callback(
        self, *, callback_context: CallbackContext, llm_response: LlmResponse
    ) -> LlmResponse | None:
        if llm_response.partial or not llm_response.content or not llm_response.content.parts:
            return None
        text = "\n".join(p.text for p in llm_response.content.parts if p.text and not p.thought)
        if not text.strip():
            return None
        filters = await self._screen(text, is_prompt=False)
        if not filters:
            return None
        log_event("model_armor_response_blocked", severity=logging.WARNING, filters=filters,
                  agent=callback_context.agent_name)
        return LlmResponse(content=types.Content(role="model", parts=[types.Part.from_text(text=_BLOCKED_REPLY)]))
