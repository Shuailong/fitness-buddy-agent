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

"""Per-turn context for the model: the user's local date, weekday and UI language.

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


_UI_LANG_MARKER = "[UI language: "
_UI_LANG_STATE_KEY = "ui_lang"
_LANGUAGE_NAMES = {"zh": "Simplified Chinese (简体中文)", "en": "English"}


def ui_language(callback_context: CallbackContext) -> str | None:
    """The web UI language sent with the current turn (remembered for the session).

    The web app adds a hidden ``[UI language: zh-CN]`` part to every user turn,
    including photo-only ones; resumed turns (confirmations) reuse the last one.
    """
    content = getattr(callback_context, "user_content", None)
    for part in getattr(content, "parts", None) or []:
        text = (getattr(part, "text", None) or "").strip()
        if text.startswith(_UI_LANG_MARKER):
            lang = (
                "zh" if text[len(_UI_LANG_MARKER) :].lower().startswith("zh") else "en"
            )
            if callback_context.state.get(_UI_LANG_STATE_KEY) != lang:
                callback_context.state[_UI_LANG_STATE_KEY] = lang
            return lang
    return callback_context.state.get(_UI_LANG_STATE_KEY)


def language_prompt(lang: str) -> str:
    name = _LANGUAGE_NAMES.get(lang, "English")
    return (
        f"[Language] The user's app is in {name}. Write every user-visible text in "
        f"{name}: replies, food and dish names, meal and plan titles, session focus, "
        "exercise notes, reasons and summaries (proper nouns may keep their original "
        "form). Only switch if the user writes to you in another language."
    )


async def inject_local_date(
    callback_context: CallbackContext, llm_request: LlmRequest
) -> None:
    """``before_model_callback``: adds today's local date and the UI language."""
    prompt = callback_context.state.get(_DATE_STATE_KEY)
    if prompt is None:
        try:
            profile = await repository().get_profile(storage_user_id(callback_context))
        except Exception:  # never block a reply on storage
            profile = None
        prompt = local_date_prompt(profile.timezone if profile else "UTC")
        callback_context.state[_DATE_STATE_KEY] = prompt
    prompts = [prompt]
    lang = ui_language(callback_context)
    if lang:
        prompts.append(language_prompt(lang))
    llm_request.append_instructions(prompts)
    return None
