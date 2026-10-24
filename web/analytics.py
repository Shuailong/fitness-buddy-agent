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

"""Admin analytics: adoption, usage & quality, agents and value metrics.

Definitions follow the Gemini Enterprise analytics guide, mapped onto this app:

* A user is *active* on a day when they open the app or log anything.
* N-day retention = users active in both the current and the previous N-day
  window / users active in the previous window; churn = previous-window users
  not active now / previous-window users; growth = (current - previous) /
  previous.
* A *question* is a user message or photo; an *answer* is a turn that ended
  with a reply; an *action* is something the coach saved (a logged meal,
  workout or plan card, or a confirmed change).
* An answer is *successful* when it got no thumbs-down and the user did not
  immediately re-ask (no follow-up within 30 seconds).
* A *chat session* is one user talking to one agent on one day.
* Value = successful answers x minutes saved per answer (x hourly rate on the
  client); projections scale the selected range to a year.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Any

QUESTION_INTENTS = frozenset({"message", "photo"})
ANSWERED_OUTCOMES = frozenset({"ok", "awaiting_confirmation"})
FOLLOW_UP_SECONDS = 30.0
DEFAULT_MINUTES_SAVED = 3
# Reasons offered in the thumbs-down sheet (web/static/js/feedback.js).
DISLIKE_REASONS = frozenset(
    {"inaccurate", "not_helpful", "too_slow", "unsafe", "wrong_numbers", "other"}
)

# Agents users talk to (plan_critic is an internal reviewer step).
AGENT_ORDER = (
    "fitness_coach",
    "nutrition_coach",
    "workout_planner",
    "weekly_reviewer",
    "plan_critic",
)


def _days(end: date, n: int) -> list[date]:
    return [end - timedelta(days=i) for i in range(n - 1, -1, -1)]


def _active_sets(users: list[dict[str, Any]]) -> dict[str, set[str]]:
    """Day (ISO) -> set of active user ids."""
    by_day: dict[str, set[str]] = defaultdict(set)
    for u in users:
        for d in u.get("active_dates") or []:
            by_day[d].add(u["user_id"])
    return by_day


def _window(by_day: dict[str, set[str]], end: date, n: int) -> set[str]:
    out: set[str] = set()
    for d in _days(end, n):
        out |= by_day.get(d.isoformat(), set())
    return out


def _rates(by_day: dict[str, set[str]], day: date, n: int) -> dict[str, Any]:
    cur = _window(by_day, day, n)
    prev = _window(by_day, day - timedelta(days=n), n)
    if not prev:
        return {
            "date": day.isoformat(),
            "active": len(cur),
            "previous": 0,
            "retention_pct": None,
            "churn_pct": None,
            "growth_pct": None,
        }
    returned = len(cur & prev)
    return {
        "date": day.isoformat(),
        "active": len(cur),
        "previous": len(prev),
        "retention_pct": round(returned / len(prev) * 100, 1),
        "churn_pct": round((len(prev) - returned) / len(prev) * 100, 1),
        "growth_pct": round((len(cur) - len(prev)) / len(prev) * 100, 1),
    }


def _adoption(
    users: list[dict[str, Any]],
    access_entries: list[dict[str, Any]],
    today: date,
    days: int,
) -> dict[str, Any]:
    by_day = _active_sets(users)
    range_days = _days(today, days)

    daily = [
        {"period": d.isoformat(), "users": len(by_day.get(d.isoformat(), set()))}
        for d in range_days
    ]
    # Weeks start on Monday; show at least 4 weeks.
    this_monday = today - timedelta(days=today.weekday())
    n_weeks = max(4, (days + 6) // 7 + 1)
    weekly = []
    for i in range(n_weeks - 1, -1, -1):
        start = this_monday - timedelta(weeks=i)
        end = min(start + timedelta(days=6), today)
        users_in = _window(by_day, end, (end - start).days + 1)
        weekly.append({"period": start.isoformat(), "users": len(users_in)})
    # Calendar months; show at least 3.
    monthly = []
    n_months = max(3, (days + 29) // 30 + 1)
    y, m = today.year, today.month
    months: list[tuple[int, int]] = []
    for _ in range(n_months):
        months.append((y, m))
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    for y, m in reversed(months):
        prefix = f"{y:04d}-{m:02d}"
        ids = {uid for d, s in by_day.items() if d.startswith(prefix) for uid in s}
        monthly.append({"period": prefix, "users": len(ids)})

    rates = {}
    for n in (7, 28):
        series = [_rates(by_day, d, n) for d in range_days]
        rates[f"{n}d"] = {"current": series[-1] if series else {}, "series": series}

    new_users = sum(
        1 for u in users if u.get("first_day", "") >= range_days[0].isoformat()
    )
    granted = {
        a["email"]
        for a in access_entries
        if a.get("status") == "approved" and a.get("email")
    }
    signed_in = {u["email"] for u in users if u.get("email")}
    claimed = len(granted & signed_in)
    return {
        "active_users": {"daily": daily, "weekly": weekly, "monthly": monthly},
        "rates": rates,
        "new_users": new_users,
        "seats": {
            "granted": len(granted),
            "claimed": claimed,
            "claim_rate_pct": round(claimed / len(granted) * 100, 1) if granted else 0,
        },
    }


def _successful_flags(turns: list[dict[str, Any]]) -> list[bool]:
    """Per answered turn: True unless the user re-asked within 30 seconds."""
    by_user: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for ev in turns:
        by_user[str(ev.get("user_id") or ev.get("user") or "")].append(ev)
    flags: dict[int, bool] = {}
    for evs in by_user.values():
        evs.sort(key=lambda e: float(e.get("ts") or 0))
        for i, ev in enumerate(evs):
            nxt = evs[i + 1] if i + 1 < len(evs) else None
            quick = (
                nxt is not None
                and str(nxt.get("intent")) in QUESTION_INTENTS
                and float(nxt.get("ts") or 0) - float(ev.get("ts") or 0)
                < FOLLOW_UP_SECONDS
            )
            flags[id(ev)] = not quick
    return [flags[id(ev)] for ev in turns]


def _usage_quality(
    chat_events: list[dict[str, Any]],
    ui_events: list[dict[str, Any]],
    feedback: list[dict[str, Any]],
    range_days: list[date],
) -> dict[str, Any]:
    start = range_days[0].isoformat()
    turns = [e for e in chat_events if str(e.get("day") or "") >= start]
    questions = [
        e for e in turns if str(e.get("intent") or "message") in QUESTION_INTENTS
    ]
    answers = [
        e for e in questions if str(e.get("outcome") or "ok") in ANSWERED_OUTCOMES
    ]
    flags = _successful_flags(answers)
    fb = [f for f in feedback if str(f.get("created_at") or "")[:10] >= start]
    likes = [f for f in fb if f.get("rating") == "up"]
    dislikes = [f for f in fb if f.get("rating") == "down"]
    successful = max(0, sum(flags) - len(dislikes))
    actions = sum(int(e.get("card_events") or 0) for e in turns) + sum(
        1 for e in turns if e.get("intent") == "confirm"
    )

    reasons: dict[str, int] = defaultdict(int)
    for f in dislikes:
        picked = [str(tg) for tg in f.get("tags") or [] if str(tg) in DISLIKE_REASONS]
        for tag in picked or ["no_reason"]:
            reasons[tag] += 1
    n_dislikes = max(len(dislikes), 1)

    page_views: dict[str, int] = defaultdict(int)
    for ev in ui_events:
        if ev.get("name") == "tab_view" and str(ev.get("day") or "") >= start:
            page_views[str(ev.get("tab") or "other")] += 1

    series = []
    for d in range_days:
        iso = d.isoformat()
        day_q = [e for e in questions if e.get("day") == iso]
        day_a = [
            (e, ok) for e, ok in zip(answers, flags, strict=True) if e.get("day") == iso
        ]
        series.append(
            {
                "date": iso,
                "questions": len(day_q),
                "answers": len(day_a),
                "successful": sum(1 for _, ok in day_a if ok),
                "likes": sum(1 for f in likes if str(f.get("created_at"))[:10] == iso),
                "dislikes": sum(
                    1 for f in dislikes if str(f.get("created_at"))[:10] == iso
                ),
            }
        )

    return {
        "questions": len(questions),
        "photo_questions": sum(1 for e in questions if e.get("intent") == "photo"),
        "answers": len(answers),
        "answer_rate_pct": round(len(answers) / len(questions) * 100, 1)
        if questions
        else 0,
        "actions": actions,
        "successful_answers": successful,
        "successful_answer_rate_pct": round(successful / len(answers) * 100, 1)
        if answers
        else 0,
        "likes": len(likes),
        "dislikes": len(dislikes),
        "dislike_reasons": [
            {"reason": k, "count": v, "pct": round(v / n_dislikes * 100, 1)}
            for k, v in sorted(reasons.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        "page_views": [
            {"tab": k, "count": v}
            for k, v in sorted(page_views.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        "series": series,
    }


def _agents(chat_events: list[dict[str, Any]], today: date) -> dict[str, Any]:
    """Last 30 days, per agent: active users, chat sessions and turns."""
    start = (today - timedelta(days=29)).isoformat()
    turns = [e for e in chat_events if str(e.get("day") or "") >= start]
    users: dict[str, set[str]] = defaultdict(set)
    sessions: dict[str, set[tuple[str, str]]] = defaultdict(set)
    counts: dict[str, int] = defaultdict(int)
    all_sessions: set[tuple[str, str]] = set()
    attributed = 0
    for ev in turns:
        uid = str(ev.get("user_id") or ev.get("user") or "")
        day = str(ev.get("day") or "")
        all_sessions.add((uid, day))
        agents = [str(a) for a in ev.get("agents") or [] if a]
        if agents:
            attributed += 1
        for agent in set(agents):
            users[agent].add(uid)
            sessions[agent].add((uid, day))
            counts[agent] += 1
    order = {a: i for i, a in enumerate(AGENT_ORDER)}
    rows = [
        {
            "agent": a,
            "users": len(users[a]),
            "sessions": len(sessions[a]),
            "turns": counts[a],
        }
        for a in sorted(users, key=lambda a: (order.get(a, 99), a))
    ]
    all_agent_users = set().union(*users.values()) if users else set()
    return {
        "window_days": 30,
        "active_agent_users": len(all_agent_users),
        "agents_used": len(rows),
        "total_chat_sessions": len(all_sessions),
        "attributed_turns": attributed,
        "total_turns": len(turns),
        "by_agent": rows,
    }


def build_analytics(
    *,
    users: list[dict[str, Any]],
    chat_events: list[dict[str, Any]],
    ui_events: list[dict[str, Any]],
    feedback: list[dict[str, Any]],
    access_entries: list[dict[str, Any]],
    today: date,
    days: int,
) -> dict[str, Any]:
    range_days = _days(today, days)
    usage = _usage_quality(chat_events, ui_events, feedback, range_days)
    return {
        "range": {
            "start": range_days[0].isoformat(),
            "end": today.isoformat(),
            "days": days,
        },
        "adoption": _adoption(users, access_entries, today, days),
        "usage_quality": usage,
        "agents": _agents(chat_events, today),
        "value": {
            "successful_answers": usage["successful_answers"],
            "actions": usage["actions"],
            "days": days,
            "default_minutes_saved": DEFAULT_MINUTES_SAVED,
        },
    }
