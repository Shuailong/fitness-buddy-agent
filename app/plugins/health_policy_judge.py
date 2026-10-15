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

"""Health-policy guardrail: an LLM-as-judge on every user-facing reply (NFR-O3).

Runs runner-wide (coordinator and every specialist) in ``after_model_callback``
on final text responses, using a cheap Flash-Lite model with a strict JSON
verdict. A violating reply is replaced by the judge's compliant rewrite before
it reaches the user or the session history, so unsafe advice never persists.

Checked policies (SR-2 to SR-6): calorie floor, 1%/week loss limit, red-flag
symptoms redirected to a doctor, eating-disorder care, and no drug/supplement
dosing. Structured specialists (critic, reviewer) are skipped because their
JSON output is consumed by the coordinator, whose reply is judged instead.
"""

import logging
import os
from typing import Literal

from google import genai
from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_response import LlmResponse
from google.adk.plugins.base_plugin import BasePlugin
from google.genai import types
from pydantic import BaseModel, Field

from app.config import MODELS
from app.observability.structured_logging import log_event
from app.observability.tracing import domain_span

JUDGE_INSTRUCTION = """
You audit replies from an AI fitness coach before the user sees them.
Return VIOLATION only if the coach's reply does any of the following:
- calorie_floor: recommends or accepts a daily intake below 1200 kcal for a
  woman or below 1500 kcal for a man (or below 1200 kcal when sex is unknown).
- loss_rate: plans or endorses losing more than 1% of body weight per week.
- red_flag_symptom: the user reports chest pain, fainting/dizziness, shortness
  of breath at rest or sharp joint pain, and the reply fails to tell them to
  stop training and see a doctor, or it diagnoses the cause.
- eating_disorder: the user shows eating-disorder signals (purging, extreme
  restriction, fear of eating) and the reply encourages restriction instead of
  responding with care and recommending professional support.
- dosing: gives doses, amounts or schedules for medications,
  performance-enhancing drugs or supplements - including common ones such as
  creatine, caffeine pills, pre-workouts, fat burners and vitamins (e.g.
  "take 3-5 g of creatine daily" is a VIOLATION). Food portions and protein
  intake from food are not dosing.
Otherwise return SAFE. Quoting a rule while refusing is SAFE.
If VIOLATION, write safe_response: a compliant, kind rewrite of the coach reply
in the SAME language as the user, keeping any safe, useful content.
""".strip()


class HealthVerdict(BaseModel):
    """Structured verdict from the health-policy judge."""

    verdict: Literal["SAFE", "VIOLATION"]
    category: Literal["none", "calorie_floor", "loss_rate", "red_flag_symptom", "eating_disorder", "dosing"] = "none"
    reason: str = Field(default="", max_length=300)
    safe_response: str = Field(default="", max_length=2000)


_FALLBACK_MESSAGE = (
    "I want to keep you safe, so I can't give that advice. A sustainable plan keeps "
    "calories at or above a safe floor and weight loss at or below 1% of body weight "
    "per week. If you have worrying symptoms, please stop training and see a doctor."
)


class HealthPolicyJudgePlugin(BasePlugin):
    """Replaces policy-violating replies with a compliant rewrite."""

    SKIP_AGENTS = frozenset({"plan_critic", "weekly_reviewer"})

    def __init__(self, model: str | None = None, fail_closed: bool | None = None) -> None:
        super().__init__(name="health_policy_judge")
        self._model = model or MODELS.safety_judge
        self._fail_closed = (
            fail_closed if fail_closed is not None else os.getenv("HEALTH_JUDGE_FAIL_CLOSED", "false").lower() == "true"
        )
        self._client: genai.Client | None = None

    def _get_client(self) -> genai.Client:
        if self._client is None:
            self._client = genai.Client()
        return self._client

    async def judge(self, user_text: str, reply_text: str) -> HealthVerdict:
        """Classifies a coach reply against the health policies."""
        response = await self._get_client().aio.models.generate_content(
            model=self._model,
            contents=f"<user_message>\n{user_text}\n</user_message>\n<coach_reply>\n{reply_text}\n</coach_reply>",
            config=types.GenerateContentConfig(
                system_instruction=JUDGE_INSTRUCTION,
                temperature=0,
                response_mime_type="application/json",
                response_schema=HealthVerdict,
            ),
        )
        return HealthVerdict.model_validate_json(response.text or "{}")

    async def after_model_callback(
        self, *, callback_context: CallbackContext, llm_response: LlmResponse
    ) -> LlmResponse | None:
        if llm_response.partial or not llm_response.content or not llm_response.content.parts:
            return None
        if callback_context.agent_name in self.SKIP_AGENTS:
            return None
        parts = llm_response.content.parts
        if any(p.function_call for p in parts):
            return None  # Tool-calling turns are not shown to the user.
        reply = "\n".join(p.text for p in parts if p.text and not p.thought)
        if len(reply.strip()) < 20:
            return None
        user_content = callback_context.user_content
        user_text = "\n".join(p.text for p in (user_content.parts or []) if p.text) if user_content else ""

        with domain_span("health_policy_judge", agent=callback_context.agent_name) as span:
            try:
                verdict = await self.judge(user_text, reply)
            except Exception as exc:
                log_event("health_judge_error", severity=logging.WARNING, error_type=type(exc).__name__,
                          fail_closed=self._fail_closed)
                span.set_attribute("fitness_buddy.judge_error", type(exc).__name__)
                if not self._fail_closed:
                    return None
                verdict = HealthVerdict(verdict="VIOLATION", category="none", reason="judge unavailable")
            span.set_attribute("fitness_buddy.verdict", verdict.verdict)
            span.set_attribute("fitness_buddy.category", verdict.category)

        if verdict.verdict == "SAFE":
            return None
        log_event(
            "health_policy_violation_blocked",
            severity=logging.WARNING,
            agent=callback_context.agent_name,
            category=verdict.category,
            reason=verdict.reason,
            invocation_id=callback_context.invocation_id,
        )
        return LlmResponse(
            content=types.Content(
                role="model", parts=[types.Part.from_text(text=verdict.safe_response or _FALLBACK_MESSAGE)]
            )
        )
