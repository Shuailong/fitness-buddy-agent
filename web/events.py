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

"""Turns raw ADK events into the small set of events the browser renders.

Simplified event types (sent over SSE by ``/api/chat`` and ``/api/confirm``):

* ``{"type": "text", "author", "text"}``: final model text (no thoughts).
* ``{"type": "activity", "label"}``: a tool call or a hand-off to a specialist.
* ``{"type": "confirmation", "call_id", "kind", "title", "summary", "details"}``:
  an ``adk_request_confirmation`` call raised by ``confirmation_gate``
  (``app/tools/_common.py``); rendered as a Confirm / Reject card.
* ``{"type": "card", "kind": "meal_logged", ...}``: a structured card built
  from a successful ``log_meal_entry`` tool result (items, computed totals and
  the day's progress).
* ``{"type": "error", "message"}`` and ``{"type": "done"}``.

Raw events may use camelCase (ADK API server) or snake_case (Agent Runtime)
keys; every accessor here accepts both.
"""

from __future__ import annotations

import json
from typing import Any

from web.config import DEFAULT_LANG, GREETING_TEXTS

CONFIRMATION_CALL = "adk_request_confirmation"
MEAL_LOG_TOOL = "log_meal_entry"

ACTIVITY_LABELS: dict[str, str] = {
    "workout_planner": "Asking the workout planner...",
    "nutrition_coach": "Asking the nutrition coach...",
    "weekly_reviewer": "Asking the weekly reviewer...",
    "plan_critic": "Reviewing the plan draft...",
    "list_due_check_ins": "Checking what's due...",
    "get_fitness_profile": "Reading your profile...",
    "save_fitness_profile": "Saving your profile...",
    "calculate_daily_energy_targets": "Calculating your targets...",
    "update_daily_calorie_target": "Updating your calorie target...",
    "log_workout_session": "Logging your workout...",
    "record_body_measurement": "Recording your measurement...",
    "get_body_measurement_trend": "Checking your weight trend...",
    "get_daily_nutrition_summary": "Totaling today's nutrition...",
    "get_current_training_plan": "Loading your training plan...",
    "list_recent_log_entries": "Looking up recent entries...",
    "delete_logged_entry": "Preparing the deletion...",
    "search_exercise_library": "Searching the exercise library...",
    "validate_training_plan_constraints": "Checking plan constraints...",
    "save_weekly_training_plan": "Preparing your new plan...",
    "log_meal_entry": "Logging your meal...",
    "get_weekly_progress_snapshot": "Crunching this week's numbers...",
}
ACTIVITY_LABELS_ZH: dict[str, str] = {
    "workout_planner": "正在询问训练规划师...",
    "nutrition_coach": "正在询问营养教练...",
    "weekly_reviewer": "正在询问周报教练...",
    "plan_critic": "正在审核计划草案...",
    "list_due_check_ins": "正在查看待办打卡...",
    "get_fitness_profile": "正在读取你的档案...",
    "save_fitness_profile": "正在保存你的档案...",
    "calculate_daily_energy_targets": "正在计算你的每日目标...",
    "update_daily_calorie_target": "正在更新热量目标...",
    "log_workout_session": "正在记录训练...",
    "record_body_measurement": "正在记录身体数据...",
    "get_body_measurement_trend": "正在查看体重趋势...",
    "get_daily_nutrition_summary": "正在汇总今日营养...",
    "get_current_training_plan": "正在加载训练计划...",
    "list_recent_log_entries": "正在查找最近的记录...",
    "delete_logged_entry": "正在准备删除...",
    "search_exercise_library": "正在搜索动作库...",
    "validate_training_plan_constraints": "正在检查计划约束...",
    "save_weekly_training_plan": "正在准备新计划...",
    "log_meal_entry": "正在记录这餐...",
    "get_weekly_progress_snapshot": "正在统计本周数据...",
}
_LABELS = {"en": ACTIVITY_LABELS, "zh": ACTIVITY_LABELS_ZH}
_HIDDEN_GREETINGS = frozenset(GREETING_TEXTS.values())
# Internal plumbing calls that mean nothing to the user.
SILENT_CALLS = frozenset(
    {"finish_task", "preload_memory", "load_memory", "set_model_response"}
)
# Helper agents whose replies are consumed by other agents, not by the user.
INTERNAL_AUTHORS = frozenset({"plan_critic"})


def _get(obj: dict[str, Any] | None, *keys: str) -> Any:
    """Returns the first present key (e.g. camelCase or snake_case variant)."""
    if not isinstance(obj, dict):
        return None
    for key in keys:
        if key in obj and obj[key] is not None:
            return obj[key]
    return None


def _parts(event: dict[str, Any]) -> list[dict[str, Any]]:
    content = _get(event, "content") or {}
    return [p for p in (_get(content, "parts") or []) if isinstance(p, dict)]


def _function_call(part: dict[str, Any]) -> dict[str, Any] | None:
    return _get(part, "functionCall", "function_call")


def _function_response(part: dict[str, Any]) -> dict[str, Any] | None:
    return _get(part, "functionResponse", "function_response")


def _visible_text(part: dict[str, Any]) -> str | None:
    text = part.get("text")
    if not text or part.get("thought"):
        return None
    text = text.strip()
    return text or None


def _is_structured_output(text: str) -> bool:
    """True for raw JSON objects/arrays (specialist output schemas, not prose)."""
    if not (text.startswith("{") or text.startswith("[")):
        return False
    try:
        return isinstance(json.loads(text), (dict, list))
    except ValueError:
        return False


def _coach_text(event: dict[str, Any], part: dict[str, Any]) -> str | None:
    """User-facing model text of a part, or None for thoughts / internal output."""
    if event.get("author") in INTERNAL_AUTHORS:
        return None
    text = _visible_text(part)
    if text is None or _is_structured_output(text):
        return None
    return text


def _is_hidden_event(event: dict[str, Any]) -> bool:
    """Partial chunks and history-compaction summaries are not shown."""
    actions = _get(event, "actions") or {}
    return bool(event.get("partial")) or bool(_get(actions, "compaction"))


def activity_label(call: dict[str, Any], lang: str = DEFAULT_LANG) -> str | None:
    """Human-friendly label for a tool / delegation call, or None to hide it.

    Args:
        call: The raw function call.
        lang: UI language (``en`` or ``zh``).
    """
    name = str(call.get("name") or "")
    if not name or name in SILENT_CALLS or name == CONFIRMATION_CALL:
        return None
    labels = _LABELS.get(lang, ACTIVITY_LABELS)
    zh = labels is ACTIVITY_LABELS_ZH
    if name == "transfer_to_agent":
        target = _get(_get(call, "args") or {}, "agent_name", "agentName")
        if target and str(target) in labels:
            return labels[str(target)]
        if zh:
            return "正在转交给专项教练..."
        return f"Handing over to {str(target or 'a specialist').replace('_', ' ')}..."
    if name in labels:
        return labels[name]
    return "处理中..." if zh else f"Running {name.replace('_', ' ')}..."


def confirmation_from_call(call: dict[str, Any]) -> dict[str, Any]:
    """Builds a Confirm / Reject card from an ``adk_request_confirmation`` call."""
    args = _get(call, "args") or {}
    tool_confirmation = _get(args, "toolConfirmation", "tool_confirmation") or {}
    original = _get(args, "originalFunctionCall", "original_function_call") or {}
    payload = _get(tool_confirmation, "payload") or {}
    return {
        "type": "confirmation",
        "call_id": call.get("id"),
        "kind": payload.get("kind") or original.get("name") or "action",
        "title": payload.get("title") or "Please confirm this action",
        "summary": payload.get("summary") or tool_confirmation.get("hint") or "",
        "details": payload.get("details")
        if isinstance(payload.get("details"), dict)
        else {},
    }


def meal_card_from_response(resp: dict[str, Any]) -> dict[str, Any] | None:
    """Builds a "meal logged" card from a successful ``log_meal_entry`` result.

    Totals come from the tool (computed in code), never from model prose, so the
    card always matches the dashboard.
    """
    if resp.get("name") != MEAL_LOG_TOOL:
        return None
    result = _get(resp, "response") or {}
    if not isinstance(result, dict) or result.get("status") != "logged":
        return None
    summary = result.get("daily_summary") or {}
    return {
        "type": "card",
        "kind": "meal_logged",
        "entry_id": result.get("entry_id"),
        "meal_type": result.get("meal_type"),
        "items": result.get("items") or [],
        "totals": result.get("meal_totals") or {},
        "day": {
            "consumed": summary.get("consumed") or {},
            "target_calories_kcal": summary.get("target_calories_kcal"),
            "target_protein_g": summary.get("target_protein_g"),
            "remaining_calories_kcal": summary.get("remaining_calories_kcal"),
            "remaining_protein_g": summary.get("remaining_protein_g"),
        },
    }


def simplify_event(
    event: dict[str, Any], lang: str = DEFAULT_LANG
) -> list[dict[str, Any]]:
    """Converts one raw ADK event into zero or more simplified UI events.

    Args:
        event: A raw ADK event (camelCase or snake_case keys).
        lang: UI language for activity labels (``en`` or ``zh``).
    """
    if _get(event, "errorCode", "error_code") or _get(
        event, "errorMessage", "error_message"
    ):
        return [
            {
                "type": "error",
                "message": "The coach ran into a problem with that request. Please try again.",
            }
        ]
    if _is_hidden_event(event) or event.get("author") == "user":
        return []
    author = event.get("author") or "coach"
    out: list[dict[str, Any]] = []
    for part in _parts(event):
        call = _function_call(part)
        if call:
            if call.get("name") == CONFIRMATION_CALL:
                out.append({**confirmation_from_call(call), "event_id": event.get("id")})
            elif label := activity_label(call, lang):
                out.append({"type": "activity", "label": label})
            continue
        if resp := _function_response(part):
            if card := meal_card_from_response(resp):
                out.append({**card, "event_id": event.get("id")})
            continue
        if text := _coach_text(event, part):
            out.append(
                {"type": "text", "author": author, "text": text, "event_id": event.get("id")}
            )
    return out


def _answered_confirmations(events: list[dict[str, Any]]) -> dict[str, bool]:
    answered: dict[str, bool] = {}
    for event in events:
        for part in _parts(event):
            resp = _function_response(part)
            if resp and resp.get("name") == CONFIRMATION_CALL and resp.get("id"):
                answered[resp["id"]] = bool(
                    (_get(resp, "response") or {}).get("confirmed")
                )
    return answered


def build_history(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Renders a session's events as chat history plus any pending confirmations.

    A confirmation is pending when an ``adk_request_confirmation`` call has no
    later function response with the same ID.

    Args:
        events: Raw ADK session events in chronological order.

    Returns:
        ``{"messages": [...], "pending_confirmations": [...]}`` where messages
        have ``role`` ``user`` / ``coach`` / ``decision``.
    """
    answered = _answered_confirmations(events)
    cards: dict[str, dict[str, Any]] = {}
    messages: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    for event in events:
        if _is_hidden_event(event):
            continue
        parts = _parts(event)
        if event.get("author") == "user":
            texts = [t for p in parts if (t := _visible_text(p))]
            has_image = any(_get(p, "inlineData", "inline_data") for p in parts)
            text = "\n".join(texts)
            if (text and text not in _HIDDEN_GREETINGS) or has_image:
                messages.append({"role": "user", "text": text, "has_image": has_image})
            for p in parts:
                resp = _function_response(p)
                if resp and resp.get("name") == CONFIRMATION_CALL:
                    card = cards.get(resp.get("id")) or {}
                    messages.append(
                        {
                            "role": "decision",
                            "confirmed": answered.get(resp.get("id"), False),
                            "title": card.get("title", "Requested change"),
                            # Lets the browser show a localized title by kind.
                            "kind": card.get("kind"),
                            "replaces": (card.get("details") or {}).get("replaces"),
                        }
                    )
            continue
        for p in parts:
            call = _function_call(p)
            resp = _function_response(p)
            if call and call.get("name") == CONFIRMATION_CALL:
                card = {**confirmation_from_call(call), "event_id": event.get("id")}
                cards[card["call_id"]] = card
                if card["call_id"] not in answered:
                    pending.append(card)
            elif resp:
                if meal_card := meal_card_from_response(resp):
                    messages.append(
                        {"role": "card", **meal_card, "event_id": event.get("id")}
                    )
            elif not call and (text := _coach_text(event, p)):
                messages.append(
                    {
                        "role": "coach",
                        "author": event.get("author") or "coach",
                        "text": text,
                        "event_id": event.get("id"),
                    }
                )
    return {"messages": messages, "pending_confirmations": pending}


def session_events(session: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Returns the events list of a raw session dict."""
    return list((session or {}).get("events") or [])


def session_last_update(session: dict[str, Any]) -> float:
    """Last update time (epoch seconds) of a raw session dict."""
    value = _get(session, "lastUpdateTime", "last_update_time")
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def has_pending_confirmation(session: dict[str, Any] | None) -> bool:
    """True when the session is paused on an unanswered confirmation."""
    return bool(build_history(session_events(session))["pending_confirmations"])
