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

"""Per-turn context for the model: the user's local date and weekday.

Without it the model guesses "today" (it once called a Tuesday "Wednesday"),
which breaks anything tied to the weekly plan ("change today's workout").
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_request import LlmRequest

from app.tools._common import repository, storage_user_id
from fitness_core.models import WEEKDAYS, utc_now

_DATE_STATE_KEY = "temp:local_date_prompt"


def local_date_prompt(timezone: str, now: datetime | None = None) -> str:
    """One line telling the model the user's local date, weekday and time."""
    now = now or utc_now()
    try:
        local = now.astimezone(ZoneInfo(timezone))
    except (ZoneInfoNotFoundError, ValueError):
        timezone, local = "UTC", now
    weekday = WEEKDAYS[local.weekday()]
    return (
        f"[Current context] Today is {weekday.title()}, {local.date().isoformat()}; "
        f'local time {local:%H:%M} ({timezone}). "Today" in the training plan '
        f"means {weekday}."
    )


async def inject_local_date(
    callback_context: CallbackContext, llm_request: LlmRequest
) -> None:
    """``before_model_callback``: adds today's local date to the system instruction."""
    prompt = callback_context.state.get(_DATE_STATE_KEY)
    if prompt is None:
        try:
            profile = await repository().get_profile(storage_user_id(callback_context))
        except Exception:  # never block a reply on storage
            profile = None
        prompt = local_date_prompt(profile.timezone if profile else "UTC")
        callback_context.state[_DATE_STATE_KEY] = prompt
    llm_request.append_instructions([prompt])
    return None
