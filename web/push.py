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

# ruff: noqa: RUF001 (Chinese notification copy)
"""Web Push reminders (daily meal logging, training-day nudge).

Browsers subscribe with the VAPID public key; subscriptions are stored in the
top-level ``push_subscriptions`` collection (one document per endpoint). Cloud
Scheduler calls ``POST /api/internal/push/dispatch`` every hour; for each
subscription we look at the user's local time and data and send at most one
reminder of each kind per local day:

* ``training`` at 08:00 local time on a planned training day (one-off plan
  adjustments respected) when the workout is not logged yet;
* ``meals`` at 20:00 local time when no meal was logged today.

Config (Cloud Run): ``VAPID_PUBLIC_KEY`` (base64url, uncompressed P-256 point),
``VAPID_PRIVATE_KEY`` (PEM or base64url raw key), ``VAPID_SUBJECT``
(``mailto:...``) and ``PUSH_DISPATCH_TOKEN`` (shared secret for the scheduler).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fitness_core.models import utc_now
from fitness_core.plans import effective_session
from web.observability import log_event

COLLECTION = "push_subscriptions"
KINDS = ("training", "meals")
SEND_HOUR = {"training": 8, "meals": 20}
DEFAULT_PREFS = {"training": True, "meals": True}

_COPY = {
    "training": {
        "en": (
            "Training day: {focus}",
            "About {minutes} min today - tap to see your exercises.",
        ),
        "zh": ("今天是训练日：{focus}", "约 {minutes} 分钟，点开查看今天的动作。"),
    },
    "meals": {
        "en": (
            "No meals logged today",
            "Snap a photo of what you ate - it takes 10 seconds.",
        ),
        "zh": ("今天还没记录饮食", "拍张照片就能记一餐，10 秒搞定。"),
    },
    "test": {
        "en": (
            "Reminders are on",
            "You'll get a nudge on training days and if you forget to log meals.",
        ),
        "zh": ("提醒已开启", "训练日和忘记记饮食时，我会提醒你。"),
    },
}


@dataclass(frozen=True)
class PushConfig:
    public_key: str
    private_key: str
    subject: str
    dispatch_token: str

    @property
    def enabled(self) -> bool:
        return bool(self.public_key and self.private_key)

    @classmethod
    def from_env(cls) -> PushConfig:
        return cls(
            public_key=os.environ.get("VAPID_PUBLIC_KEY", "").strip(),
            private_key=os.environ.get("VAPID_PRIVATE_KEY", "").strip(),
            subject=os.environ.get(
                "VAPID_SUBJECT", "mailto:admin@fitnessbuddy.online"
            ).strip(),
            dispatch_token=os.environ.get("PUSH_DISPATCH_TOKEN", "").strip(),
        )


def subscription_id(endpoint: str) -> str:
    return hashlib.sha256(endpoint.encode()).hexdigest()[:32]


def message(kind: str, lang: str, **values: Any) -> dict[str, str]:
    """Localized notification payload (title, body, url, tag)."""
    title, body = _COPY[kind]["zh" if lang == "zh" else "en"]
    return {
        "title": title.format(**values),
        "body": body.format(**values),
        "url": "/#plan" if kind == "training" else "/#today",
        "tag": f"fb-{kind}",
    }


# ------------------------------------------------------------------ storage
def _memory(repo: Any) -> dict[str, dict[str, Any]]:
    store = getattr(repo, "push_store", None)
    if store is None:
        store = {}
        repo.push_store = store
    return store


async def save_subscription(repo: Any, record: dict[str, Any]) -> None:
    sid = subscription_id(record["endpoint"])
    db = getattr(repo, "_db", None)
    if db is not None:
        await db.collection(COLLECTION).document(sid).set(record, merge=True)
        return
    store = _memory(repo)
    store[sid] = {**store.get(sid, {}), **record}


async def get_subscription(repo: Any, endpoint: str) -> dict[str, Any] | None:
    sid = subscription_id(endpoint)
    db = getattr(repo, "_db", None)
    if db is not None:
        snap = await db.collection(COLLECTION).document(sid).get()
        return snap.to_dict() if snap.exists else None
    found = _memory(repo).get(sid)
    return dict(found) if found else None


async def delete_subscription(repo: Any, endpoint: str) -> None:
    sid = subscription_id(endpoint)
    db = getattr(repo, "_db", None)
    if db is not None:
        await db.collection(COLLECTION).document(sid).delete()
        return
    _memory(repo).pop(sid, None)


async def list_subscriptions(
    repo: Any, user_id: str | None = None
) -> list[dict[str, Any]]:
    db = getattr(repo, "_db", None)
    if db is not None:
        query = db.collection(COLLECTION)
        if user_id:
            query = query.where("user_id", "==", user_id)
        return [doc.to_dict() async for doc in query.stream()]
    return [
        dict(s)
        for s in _memory(repo).values()
        if not user_id or s.get("user_id") == user_id
    ]


async def delete_user_subscriptions(repo: Any, user_id: str) -> int:
    subs = await list_subscriptions(repo, user_id)
    for sub in subs:
        await delete_subscription(repo, sub["endpoint"])
    return len(subs)


# ------------------------------------------------------------------ sending
def _private_key(raw: str):
    """py_vapid key from a PEM or a base64url raw private key."""
    from py_vapid import Vapid

    if "BEGIN" in raw:
        return Vapid.from_pem(raw.encode())
    return Vapid.from_raw(raw.encode())


def _send_sync(config: PushConfig, sub: dict[str, Any], payload: dict[str, str]) -> int:
    """Sends one notification; returns the push service HTTP status."""
    from pywebpush import WebPushException, webpush

    try:
        resp = webpush(
            subscription_info={"endpoint": sub["endpoint"], "keys": sub["keys"]},
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=_private_key(config.private_key),
            vapid_claims={"sub": config.subject},
            ttl=6 * 3600,
        )
        return int(getattr(resp, "status_code", 201) or 201)
    except WebPushException as exc:
        return int(getattr(exc.response, "status_code", 0) or 0)


async def send(
    config: PushConfig, repo: Any, sub: dict[str, Any], payload: dict[str, str]
) -> bool:
    """Sends a notification; removes subscriptions the browser has revoked."""
    try:
        status = await asyncio.to_thread(_send_sync, config, sub, payload)
    except Exception as exc:  # network / key errors: count as failed, keep going
        log_event("push_send_error", severity=logging.WARNING, error=type(exc).__name__)
        status = 0
    if status in (404, 410):
        await delete_subscription(repo, sub["endpoint"])
    ok = 200 <= status < 300
    if not ok:
        log_event("push_send_failed", severity=logging.WARNING, status=status)
    return ok


# ------------------------------------------------------------------ scheduling
def _local_now(timezone: str, now: datetime) -> datetime:
    try:
        return now.astimezone(ZoneInfo(timezone or "UTC"))
    except (ZoneInfoNotFoundError, ValueError):
        return now


async def due_messages(
    repo: Any, sub: dict[str, Any], now: datetime | None = None
) -> list[tuple[str, dict[str, str], str]]:
    """Reminders due now as (kind, payload, local date); at most one per kind per day."""
    user_id = sub.get("user_id") or ""
    profile = await repo.get_profile(user_id)
    if profile is None:
        return []
    local = _local_now(
        profile.timezone or sub.get("timezone") or "UTC", now or utc_now()
    )
    today = local.date()
    iso = today.isoformat()
    prefs = {**DEFAULT_PREFS, **(sub.get("prefs") or {})}
    last = sub.get("last_sent") or {}
    lang = sub.get("lang") or "en"
    out: list[tuple[str, dict[str, str], str]] = []
    for kind in KINDS:
        if (
            not prefs.get(kind)
            or last.get(kind) == iso
            or local.hour != SEND_HOUR[kind]
        ):
            continue
        if kind == "training":
            plan = await repo.get_current_plan(user_id)
            adjustments = await repo.list_plan_adjustments(user_id, start=iso, end=iso)
            session, _ = effective_session(plan, adjustments, today)
            if session is None or await repo.list_workouts(user_id, start=iso, end=iso):
                continue
            payload = message(
                kind, lang, focus=session.focus, minutes=session.estimated_minutes
            )
            out.append((kind, payload, iso))
        elif kind == "meals":
            if await repo.list_meals(user_id, start=iso, end=iso):
                continue
            out.append((kind, message(kind, lang), iso))
    return out


async def dispatch(
    config: PushConfig, repo: Any, now: datetime | None = None
) -> dict[str, int]:
    """Sends every reminder that is due now; safe to call repeatedly (hourly)."""
    stats = {"subscriptions": 0, "sent": 0, "failed": 0}
    now = now or utc_now()
    for sub in await list_subscriptions(repo):
        stats["subscriptions"] += 1
        try:
            due = await due_messages(repo, sub, now)
        except Exception as exc:  # one bad record must not stop the run
            log_event(
                "push_due_failed", severity=logging.WARNING, error=type(exc).__name__
            )
            continue
        for kind, payload, local_day in due:
            if await send(config, repo, sub, payload):
                stats["sent"] += 1
                last = {**(sub.get("last_sent") or {}), kind: local_day}
                sub["last_sent"] = last
                await save_subscription(
                    repo, {"endpoint": sub["endpoint"], "last_sent": last}
                )
            else:
                stats["failed"] += 1
    return stats
