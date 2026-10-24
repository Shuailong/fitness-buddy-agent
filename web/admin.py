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

"""Admin console telemetry tracker, RBAC allowlist manager, and metrics aggregator.

Persists operational events and user presence to Firestore (``ops_users``,
``ops_events``, ``waitlist``) when running with ``FirestoreFitnessRepository``,
and falls back to in-memory attributes on ``InMemoryFitnessRepository`` during
unit tests or local offline development.
"""

from __future__ import annotations

import hashlib
import math
import os
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import Request

from fitness_core.models import utc_now
from web.analytics import build_analytics
from web.auth import CurrentUser, list_waitlist_entries, save_waitlist_entry
from web.config import WebSettings, normalize_lang
from web.ratelimit import default_limits

# Gemini 2.5 blended pricing estimates (USD) + Cloud Run / Agent Engine overhead.
INPUT_COST_PER_TOKEN_USD = 1.25 / 1_000_000
OUTPUT_COST_PER_TOKEN_USD = 10.00 / 1_000_000
TURN_INFRA_OVERHEAD_USD = 0.0004
MONTHLY_BUDGET_USD = 100.0

COUNTRY_NAMES: dict[str, tuple[str, str]] = {
    "CN": ("China", "中国"),
    "US": ("United States", "美国"),
    "SG": ("Singapore", "新加坡"),
    "HK": ("Hong Kong", "中国香港"),
    "TW": ("Taiwan", "中国台湾"),
    "JP": ("Japan", "日本"),
    "GB": ("United Kingdom", "英国"),
    "CA": ("Canada", "加拿大"),
    "AU": ("Australia", "澳大利亚"),
    "DE": ("Germany", "德国"),
    "FR": ("France", "法国"),
    "KR": ("South Korea", "韩国"),
    "IN": ("India", "印度"),
    "LOCAL": ("Local / Dev", "本地开发环境"),
    "UNSET": ("Unknown", "未知地区"),
}

_TZ_TO_COUNTRY: dict[str, str] = {
    "asia/shanghai": "CN",
    "asia/chongqing": "CN",
    "asia/harbin": "CN",
    "asia/urumqi": "CN",
    "asia/beijing": "CN",
    "asia/hong_kong": "HK",
    "asia/taipei": "TW",
    "asia/singapore": "SG",
    "asia/tokyo": "JP",
    "asia/seoul": "KR",
    "asia/kolkata": "IN",
    "america/los_angeles": "US",
    "america/new_york": "US",
    "america/chicago": "US",
    "america/denver": "US",
    "america/phoenix": "US",
    "america/toronto": "CA",
    "america/vancouver": "CA",
    "europe/london": "GB",
    "europe/berlin": "DE",
    "europe/paris": "FR",
    "australia/sydney": "AU",
    "australia/melbourne": "AU",
}


def _pseudonym(user_id: str) -> str:
    return hashlib.sha256(user_id.encode()).hexdigest()[:12]


def infer_country_from_tz_or_lang(
    timezone: str | None = None,
    accept_language: str | None = None,
    is_local: bool = False,
) -> str:
    """Best-effort country code when Cloud Run / CDN geo headers are absent."""
    tz = (timezone or "").strip().lower()
    if tz in _TZ_TO_COUNTRY:
        return _TZ_TO_COUNTRY[tz]
    if tz.startswith("america/"):
        return "US"
    if tz.startswith("europe/"):
        return "DE"
    if tz.startswith("australia/"):
        return "AU"
    al = (accept_language or "").strip()
    first = al.split(",")[0].strip() if al else ""
    if "-" in first:
        region = first.split("-", 1)[1].split(";")[0].strip().upper()
        if len(region) == 2 and region.isalpha():
            return region
    if first.lower().startswith("zh"):
        return "CN"
    if is_local:
        return "LOCAL"
    return "US"


def extract_client_geo(
    request: Request | None,
    fallback_tz: str | None = None,
    fallback_lang: str | None = None,
) -> dict[str, str]:
    """Extracts country/region from request headers with timezone/locale fallback."""
    if request is None:
        country = infer_country_from_tz_or_lang(fallback_tz, fallback_lang)
        return {"country": country, "region": ""}
    headers = request.headers
    country = ""
    region = ""
    # 1. Google Cloud Load Balancer: X-Client-Geo-Location: "<country>, <region>"
    gclb = headers.get("x-client-geo-location", "").strip()
    if gclb:
        parts = [p.strip() for p in gclb.split(",") if p.strip()]
        if parts:
            country = parts[0].upper()
        if len(parts) > 1:
            region = parts[1].upper()
    # 2. App Engine / Cloud Run internal geo headers or Cloudflare
    if not country:
        country = (
            (
                headers.get("x-appengine-country", "")
                or headers.get("cf-ipcountry", "")
                or headers.get("x-country-code", "")
            )
            .strip()
            .upper()
        )
    if not region:
        region = headers.get("x-appengine-region", "").strip().upper()
    if country in ("", "ZZ", "XX", "UNKNOWN"):
        host = (request.url.hostname or "") if request.url else ""
        is_local = host in ("localhost", "127.0.0.1", "testserver")
        country = infer_country_from_tz_or_lang(
            fallback_tz,
            headers.get("accept-language") or fallback_lang,
            is_local=is_local,
        )
    return {"country": country, "region": region}


def estimate_turn_tokens_and_cost(
    *,
    intent: str,
    input_chars: int,
    has_image: bool,
    activity_events: int,
    confirmation_events: int,
    text_events: int,
) -> dict[str, int | float]:
    """Estimates Gemini 2.5 input/output tokens and USD cost for a single turn."""
    # System prompt + profile/memory context (~1,650 tokens) + user input
    input_tokens = 1650 + max(12, int(input_chars / 3.2))
    if has_image or intent == "photo":
        input_tokens += 1290  # Gemini multimodal image tile budget
    # Each sub-agent / tool call adds context round-trip tokens
    input_tokens += int(activity_events) * 920
    if confirmation_events:
        input_tokens += 450

    output_tokens = (
        (280 if text_events else 80)
        + int(activity_events) * 220
        + int(confirmation_events) * 340
    )
    cost_usd = (
        input_tokens * INPUT_COST_PER_TOKEN_USD
        + output_tokens * OUTPUT_COST_PER_TOKEN_USD
        + TURN_INFRA_OVERHEAD_USD
    )
    return {
        "est_input_tokens": input_tokens,
        "est_output_tokens": output_tokens,
        "est_cost_usd": round(cost_usd, 6),
    }


def _ops_users_mem(repo: Any) -> dict[str, dict[str, Any]]:
    store = getattr(repo, "ops_users", None)
    if store is None:
        store = {}
        repo.ops_users = store
    return store


def _ops_events_mem(repo: Any) -> list[dict[str, Any]]:
    events = getattr(repo, "ops_events", None)
    if events is None:
        events = []
        repo.ops_events = events
    return events


def _privacy_prefs_mem(repo: Any) -> dict[str, dict[str, Any]]:
    prefs = getattr(repo, "privacy_prefs", None)
    if prefs is None:
        prefs = {}
        repo.privacy_prefs = prefs
    return prefs


async def get_user_privacy_pref(repo: Any, user_id: str) -> dict[str, Any]:
    """Returns the user's PDPA privacy & usage-sharing consent preference."""
    default_pref = {
        "share_usage_data": True,
        "chat_private_from_admins": True,
        "updated_at": None,
    }
    if not user_id:
        return default_pref
    mem_prefs = _privacy_prefs_mem(repo)
    if user_id in mem_prefs:
        return {**default_pref, **mem_prefs[user_id]}
    db = getattr(repo, "_db", None)
    if db is not None:
        try:
            snap = await db.collection("privacy_prefs").document(user_id).get()
            if snap.exists:
                data = snap.to_dict() or {}
                record = {
                    "share_usage_data": bool(data.get("share_usage_data", True)),
                    "chat_private_from_admins": True,
                    "updated_at": data.get("updated_at"),
                }
                mem_prefs[user_id] = record
                return record
        except Exception:
            pass
    mem_prefs[user_id] = dict(default_pref)
    return dict(default_pref)


async def purge_user_telemetry(repo: Any, user_id: str) -> int:
    """Purges stored ``ops_users`` and ``ops_events`` for ``user_id`` upon PDPA consent withdrawal."""
    if not user_id:
        return 0
    purged = 0
    mem_users = _ops_users_mem(repo)
    if mem_users.pop(user_id, None) is not None:
        purged += 1
    mem_events = _ops_events_mem(repo)
    before_len = len(mem_events)
    mem_events[:] = [e for e in mem_events if e.get("user_id") != user_id]
    purged += before_len - len(mem_events)

    db = getattr(repo, "_db", None)
    if db is not None:
        try:
            await db.collection("ops_users").document(user_id).delete()
            purged += 1
        except Exception:
            pass
        try:
            query = db.collection("ops_events").where("user_id", "==", user_id).limit(500)
            async for doc in query.stream():
                await doc.reference.delete()
                purged += 1
        except Exception:
            pass
    return purged


async def set_user_privacy_pref(
    repo: Any,
    user: CurrentUser,
    *,
    share_usage_data: bool,
) -> dict[str, Any]:
    """Saves the user's PDPA usage-data consent and purges telemetry if withdrawn."""
    now_iso = utc_now().isoformat()
    record = {
        "user_id": user.user_id,
        "share_usage_data": bool(share_usage_data),
        "chat_private_from_admins": True,
        "updated_at": now_iso,
    }
    _privacy_prefs_mem(repo)[user.user_id] = dict(record)
    db = getattr(repo, "_db", None)
    if db is not None:
        try:
            await (
                db.collection("privacy_prefs")
                .document(user.user_id)
                .set(record, merge=True)
            )
        except Exception:
            pass
    purged = 0
    if not share_usage_data:
        purged = await purge_user_telemetry(repo, user.user_id)
    return {
        "ok": True,
        "share_usage_data": bool(share_usage_data),
        "chat_private_from_admins": True,
        "purged_telemetry": not share_usage_data,
        "purged_records": purged,
        "updated_at": now_iso,
    }


async def touch_user_presence(
    repo: Any,
    user: CurrentUser,
    *,
    request: Request | None = None,
    lang: str | None = None,
    timezone: str | None = None,
    increment_turn: bool = False,
    increment_photo: bool = False,
    increment_error: bool = False,
    onboarding_completed: bool = False,
) -> None:
    """Updates real-time user presence and metadata in ``ops_users``."""
    pref = await get_user_privacy_pref(repo, user.user_id)
    if not pref.get("share_usage_data", True):
        return
    now = utc_now()
    now_ts = now.timestamp()
    now_iso = now.isoformat()
    today_str = now.date().isoformat()
    geo = extract_client_geo(request, fallback_tz=timezone, fallback_lang=lang)

    db = getattr(repo, "_db", None)
    mem_store = _ops_users_mem(repo)
    cached = mem_store.get(user.user_id)
    last_synced_ts = float((cached or {}).get("_synced_ts") or 0.0)
    existing: dict[str, Any] = {}
    if cached is not None:
        existing = {k: v for k, v in cached.items() if k != "_synced_ts"}
    elif db is not None:
        try:
            snap = await db.collection("ops_users").document(user.user_id).get()
            if snap.exists:
                existing = snap.to_dict() or {}
        except Exception:
            existing = {}

    active_dates = list(existing.get("active_dates") or [])
    if today_str not in active_dates:
        active_dates.append(today_str)
        # ~4 months: enough for 28-day retention over a 90-day range.
        active_dates = sorted(set(active_dates))[-120:]

    country = geo["country"]
    if existing.get("country") and country in ("LOCAL", "UNSET"):
        country = str(existing["country"])

    updated: dict[str, Any] = {
        **existing,
        "user_id": user.user_id,
        "user_hash": _pseudonym(user.user_id),
        "email": (user.email or existing.get("email") or "").lower(),
        "given_name": user.given_name or existing.get("given_name") or "",
        "first_seen_at": existing.get("first_seen_at") or now_iso,
        "first_seen_day": existing.get("first_seen_day") or today_str,
        "last_seen_at": now_iso,
        "last_seen_ts": now_ts,
        "active_dates": active_dates,
        "country": country or existing.get("country") or "US",
        "region": geo["region"] or existing.get("region") or "",
        "timezone": timezone or existing.get("timezone") or "",
        "lang": normalize_lang(lang or existing.get("lang") or "en"),
        "total_turns": int(existing.get("total_turns", 0))
        + (1 if increment_turn else 0),
        "total_photos": int(existing.get("total_photos", 0))
        + (1 if increment_photo else 0),
        "total_errors": int(existing.get("total_errors", 0))
        + (1 if increment_error else 0),
        "onboarding_completed": bool(
            existing.get("onboarding_completed") or onboarding_completed
        ),
    }

    has_state_change = bool(
        increment_turn
        or increment_photo
        or increment_error
        or (onboarding_completed and not existing.get("onboarding_completed"))
        or (timezone and timezone != existing.get("timezone"))
        or (lang and normalize_lang(lang) != existing.get("lang"))
    )
    should_sync_db = has_state_change or (now_ts - last_synced_ts >= 45.0)
    mem_store[user.user_id] = {
        **updated,
        "_synced_ts": now_ts if should_sync_db else last_synced_ts,
    }

    if db is not None and should_sync_db:
        try:
            await (
                db.collection("ops_users")
                .document(user.user_id)
                .set(updated, merge=True)
            )
        except Exception:
            pass


async def record_ops_event(
    repo: Any,
    kind: str,
    *,
    user_id: str = "",
    email: str = "",
    **fields: Any,
) -> None:
    """Appends an operational telemetry event to ``ops_events``."""
    if user_id and kind in ("ui_event", "telemetry", "chat_turn"):
        pref = await get_user_privacy_pref(repo, user_id)
        if not pref.get("share_usage_data", True):
            return
    now = utc_now()
    event_id = f"{int(now.timestamp() * 1000)}_{uuid.uuid4().hex[:8]}"
    record: dict[str, Any] = {
        "event_id": event_id,
        "kind": kind,
        "ts": now.timestamp(),
        "created_at": now.isoformat(),
        "day": now.date().isoformat(),
        "user_id": user_id,
        "user": _pseudonym(user_id) if user_id else "",
        "email": email.lower() if email else "",
        **fields,
    }
    db = getattr(repo, "_db", None)
    if db is not None:
        try:
            await db.collection("ops_events").document(event_id).set(record)
        except Exception:
            pass
    else:
        events = _ops_events_mem(repo)
        events.append(record)
        if len(events) > 2000:
            del events[:-2000]


async def update_access_entry(
    repo: Any,
    *,
    email: str,
    status: str = "approved",
    role: str = "member",
    given_name: str = "",
    note: str = "",
    updated_by: str = "",
) -> dict[str, Any]:
    """Creates or updates an allowlist/waitlist entry and role assignment."""
    clean_email = email.strip().lower()
    now_iso = utc_now().isoformat()
    existing_map = await list_waitlist_entries(repo)
    existing = existing_map.get(clean_email, {})
    record: dict[str, Any] = {
        **existing,
        "email": clean_email,
        "status": status,
        "role": role,
        "requested_at": existing.get("requested_at") or now_iso,
        "updated_at": now_iso,
        "updated_by": updated_by,
    }
    if given_name.strip():
        record["given_name"] = given_name.strip()[:60]
    if note.strip():
        record["note"] = note.strip()[:200]
    await save_waitlist_entry(repo, clean_email, record)
    return record


def _percentile(sorted_vals: list[int], q: float) -> int:
    if not sorted_vals:
        return 0
    if len(sorted_vals) == 1:
        return int(sorted_vals[0])
    idx = min(len(sorted_vals) - 1, max(0, math.ceil(q * len(sorted_vals)) - 1))
    return int(sorted_vals[idx])


async def _load_all_repo_data(
    repo: Any, cutoff_ts: float
) -> tuple[
    dict[str, dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[str, dict[str, Any]],
]:
    """Loads ops_users, ops_events, feedback, and domain user stats."""
    db = getattr(repo, "_db", None)
    if db is None:
        # In-memory repository
        ops_users = dict(_ops_users_mem(repo))
        ops_events = [
            dict(e) for e in _ops_events_mem(repo) if float(e.get("ts", 0)) >= cutoff_ts
        ]
        feedback = [dict(f) for f in getattr(repo, "feedback", [])]
        domain_users: dict[str, dict[str, Any]] = {}
        profiles = getattr(repo, "_profiles", {})
        plans = getattr(repo, "_plans", {})
        entries = getattr(repo, "_entries", {})
        all_uids = (
            set(profiles.keys())
            | set(plans.keys())
            | {uid for (uid, _) in entries.keys()}
            | set(ops_users.keys())
        )
        for uid in all_uids:
            prof = profiles.get(uid)
            meals = list(entries.get((uid, "meal_logs"), {}).values())
            workouts = list(entries.get((uid, "workout_logs"), {}).values())
            measurements = list(entries.get((uid, "body_measurements"), {}).values())
            reviews = list(entries.get((uid, "weekly_reviews"), {}).values())
            domain_users[uid] = {
                "has_profile": prof is not None,
                "timezone": getattr(prof, "timezone", "") if prof else "",
                "goal": getattr(prof, "goal", "") if prof else "",
                "created_day": (
                    prof.created_at.date().isoformat()
                    if prof and getattr(prof, "created_at", None)
                    else ""
                ),
                "has_plan": uid in plans,
                "meal_dates": [getattr(m, "local_date", "") for m in meals],
                "workout_dates": [getattr(w, "local_date", "") for w in workouts],
                "measurement_count": len(measurements),
                "review_count": len(reviews),
            }
        return ops_users, ops_events, feedback, domain_users

    # Firestore repository
    ops_users = {}
    try:
        async for doc in db.collection("ops_users").stream():
            ops_users[doc.id] = doc.to_dict() or {}
    except Exception:
        pass

    ops_events = []
    try:
        query = db.collection("ops_events").where("ts", ">=", cutoff_ts).limit(8000)
        async for doc in query.stream():
            ops_events.append(doc.to_dict() or {})
    except Exception:
        pass

    feedback = []
    try:
        async for doc in db.collection("feedback").limit(200).stream():
            feedback.append(doc.to_dict() or {})
    except Exception:
        pass

    domain_users = {}
    try:
        async for user_doc in db.collection("users").stream():
            uid = user_doc.id
            p_data = user_doc.to_dict() or {}
            created_raw = str(p_data.get("created_at") or "")
            created_day = created_raw[:10] if len(created_raw) >= 10 else ""
            meal_dates: list[str] = []
            workout_dates: list[str] = []
            measurement_count = 0
            review_count = 0
            has_plan = False
            try:
                plan_snap = (
                    await user_doc.reference.collection("training_plans")
                    .document("current")
                    .get()
                )
                has_plan = bool(plan_snap.exists)
            except Exception:
                pass
            try:
                async for m in user_doc.reference.collection("meal_logs").stream():
                    d = (m.to_dict() or {}).get("local_date", "")
                    if d:
                        meal_dates.append(str(d))
            except Exception:
                pass
            try:
                async for w in user_doc.reference.collection("workout_logs").stream():
                    d = (w.to_dict() or {}).get("local_date", "")
                    if d:
                        workout_dates.append(str(d))
            except Exception:
                pass
            try:
                async for _ in user_doc.reference.collection(
                    "body_measurements"
                ).stream():
                    measurement_count += 1
            except Exception:
                pass
            try:
                async for _ in user_doc.reference.collection("weekly_reviews").stream():
                    review_count += 1
            except Exception:
                pass

            domain_users[uid] = {
                "has_profile": bool(p_data.get("goal")),
                "timezone": str(p_data.get("timezone") or ""),
                "goal": str(p_data.get("goal") or ""),
                "created_day": created_day,
                "has_plan": has_plan,
                "meal_dates": meal_dates,
                "workout_dates": workout_dates,
                "measurement_count": measurement_count,
                "review_count": review_count,
            }
    except Exception:
        pass

    return ops_users, ops_events, feedback, domain_users


async def build_admin_overview(
    repo: Any,
    settings: WebSettings,
    *,
    days: int = 14,
    asset_version: str = "",
) -> dict[str, Any]:
    """Aggregates all admin dashboard panels: growth, online, geo, features,
    funnel, feedback, model stability/cost, system stability, and access control.
    """
    days = max(7, min(90, int(days or 14)))
    now = utc_now()
    now_ts = time.time()
    today_date = now.date()
    today_iso = today_date.isoformat()
    month_prefix = today_iso[:7]  # YYYY-MM
    cutoff_30d_ts = now_ts - max(30, days) * 86400

    waitlist_map = await list_waitlist_entries(repo)
    ops_users, ops_events, feedback_list, domain_users = await _load_all_repo_data(
        repo, cutoff_30d_ts
    )

    # ------------------------------------------------- 1. Access control table
    all_emails = (
        set(waitlist_map.keys())
        | {e.lower() for e in settings.allowed_emails}
        | {e.lower() for e in settings.admin_emails}
    )
    access_entries: list[dict[str, Any]] = []
    for email in sorted(all_emails):
        if not email:
            continue
        w = waitlist_map.get(email, {})
        in_admin_env = email in settings.admin_emails
        in_allow_env = email in settings.allowed_emails
        raw_status = str(w.get("status") or "").lower()
        if in_admin_env:
            status = "approved"
        elif raw_status in ("pending", "approved", "revoked"):
            status = raw_status
        elif in_allow_env:
            status = "approved"
        else:
            status = "pending"

        role = (
            "admin"
            if (
                in_admin_env
                or (status != "revoked" and str(w.get("role", "")).lower() == "admin")
            )
            else "member"
        )
        source = (
            "env_admin"
            if in_admin_env
            else ("env_allowlist" if in_allow_env and not w else "waitlist")
        )
        access_entries.append(
            {
                "email": email,
                "given_name": str(w.get("given_name") or ""),
                "status": status,
                "role": role,
                "lang": str(w.get("lang") or "en"),
                "requested_at": str(w.get("requested_at") or ""),
                "updated_at": str(w.get("updated_at") or ""),
                "updated_by": str(w.get("updated_by") or ""),
                "note": str(w.get("note") or ""),
                "source": source,
            }
        )

    status_order = {"pending": 0, "approved": 1, "revoked": 2}
    access_entries.sort(
        key=lambda item: (
            status_order.get(item["status"], 9),
            0 if item["role"] == "admin" else 1,
            item["email"],
        )
    )
    waitlist_pending = sum(1 for a in access_entries if a["status"] == "pending")
    waitlist_approved = sum(1 for a in access_entries if a["status"] == "approved")

    # ------------------------------------ 2. Merge user profiles & ops_users
    all_uids = set(ops_users.keys()) | set(domain_users.keys())
    merged_users: list[dict[str, Any]] = []
    for uid in all_uids:
        ou = ops_users.get(uid, {})
        du = domain_users.get(uid, {})
        tz = str(ou.get("timezone") or du.get("timezone") or "UTC")
        lang = normalize_lang(str(ou.get("lang") or "en"))
        country = str(ou.get("country") or "")
        if not country or country in ("UNSET", "UNKNOWN"):
            country = infer_country_from_tz_or_lang(tz, lang)
        active_dates = set(ou.get("active_dates") or [])
        active_dates.update(d for d in du.get("meal_dates", []) if d)
        active_dates.update(d for d in du.get("workout_dates", []) if d)
        if du.get("created_day"):
            active_dates.add(du["created_day"])
        sorted_dates = sorted(d for d in active_dates if d)
        first_day = (
            str(ou.get("first_seen_day") or "")
            or (sorted_dates[0] if sorted_dates else "")
            or today_iso
        )
        last_seen_ts = float(ou.get("last_seen_ts") or 0.0)
        if not last_seen_ts and sorted_dates:
            try:
                last_seen_ts = (
                    datetime.fromisoformat(sorted_dates[-1])
                    .replace(tzinfo=UTC)
                    .timestamp()
                )
            except ValueError:
                last_seen_ts = 0.0
        email = str(ou.get("email") or "").lower()
        role = (
            "admin"
            if (
                email in settings.admin_emails
                or (
                    email in waitlist_map
                    and waitlist_map[email].get("role") == "admin"
                    and waitlist_map[email].get("status") != "revoked"
                )
            )
            else "member"
        )
        has_activity = bool(
            du.get("meal_dates")
            or du.get("workout_dates")
            or du.get("measurement_count", 0) > 0
            or du.get("has_plan")
        )
        merged_users.append(
            {
                "user_id": uid,
                "user_hash": str(ou.get("user_hash") or _pseudonym(uid)),
                "email": email,
                "given_name": str(ou.get("given_name") or ""),
                "role": role,
                "country": country,
                "region": str(ou.get("region") or ""),
                "timezone": tz,
                "lang": lang,
                "first_day": first_day,
                "active_dates": sorted_dates,
                "last_seen_ts": last_seen_ts,
                "last_seen_at": str(ou.get("last_seen_at") or ""),
                "total_turns": int(ou.get("total_turns") or 0),
                "has_profile": bool(
                    du.get("has_profile") or ou.get("onboarding_completed")
                ),
                "has_activity": has_activity,
            }
        )

    # Online / Active / Retention calculations
    online_5m = 0
    active_15m = 0
    dau_uids: set[str] = set()
    wau_uids: set[str] = set()
    mau_uids: set[str] = set()
    d1_retained = 0
    d7_retained = 0
    date_7d_ago = (today_date - timedelta(days=6)).isoformat()
    date_30d_ago = (today_date - timedelta(days=29)).isoformat()

    online_user_rows: list[dict[str, Any]] = []
    for u in merged_users:
        age_sec = (
            max(0, int(now_ts - u["last_seen_ts"])) if u["last_seen_ts"] else 999999
        )
        if age_sec <= 300:
            online_5m += 1
            presence_state = "online"
        elif age_sec <= 900:
            active_15m += 1
            presence_state = "recent"
        else:
            presence_state = "idle"
        if age_sec <= 300:
            active_15m += 1

        ad = u["active_dates"]
        if today_iso in ad or age_sec <= 86400:
            dau_uids.add(u["user_id"])
        if any(d >= date_7d_ago for d in ad) or age_sec <= 7 * 86400:
            wau_uids.add(u["user_id"])
        if any(d >= date_30d_ago for d in ad) or age_sec <= 30 * 86400:
            mau_uids.add(u["user_id"])

        if len(ad) >= 2 or u["total_turns"] >= 3:
            d1_retained += 1
        if len(ad) >= 3 or (
            len(ad) >= 2 and ad[0] <= date_7d_ago and ad[-1] >= date_7d_ago
        ):
            d7_retained += 1

        u_pref = await get_user_privacy_pref(repo, u["user_id"])
        if not u_pref.get("share_usage_data", True):
            continue

        online_user_rows.append(
            {
                "user_hash": u["user_hash"],
                "email": u["email"] or f"user-{u['user_hash'][:6]}",
                "given_name": u["given_name"],
                "role": u["role"],
                "status_online": presence_state,
                "seconds_ago": age_sec if u["last_seen_ts"] else None,
                "country": u["country"],
                "timezone": u["timezone"],
                "lang": u["lang"],
                "total_turns": u["total_turns"],
                "has_profile": u["has_profile"],
                "last_seen_at": u["last_seen_at"],
            }
        )

    online_user_rows.sort(
        key=lambda r: (
            0
            if r["status_online"] == "online"
            else (1 if r["status_online"] == "recent" else 2),
            r["seconds_ago"] if r["seconds_ago"] is not None else 999999,
        )
    )

    total_users = max(len(merged_users), waitlist_approved)
    profiled_users = sum(1 for u in merged_users if u["has_profile"])
    dau = len(dau_uids)
    wau = len(wau_uids)
    mau = max(len(mau_uids), dau)
    denom_users = max(len(merged_users), 1)
    d1_retention_pct = (
        round(d1_retained / denom_users * 100, 1) if merged_users else 0.0
    )
    d7_retention_pct = (
        round(d7_retained / denom_users * 100, 1) if merged_users else 0.0
    )
    stickiness_pct = round(dau / max(mau, 1) * 100, 1) if mau else 0.0

    # ---------------------------------------------- 3. Geography distribution
    country_counts: dict[str, int] = {}
    tz_counts: dict[str, int] = {}
    lang_counts: dict[str, int] = {}
    for u in merged_users:
        c = u["country"] or "UNSET"
        country_counts[c] = country_counts.get(c, 0) + 1
        tz = u["timezone"] or "UTC"
        tz_counts[tz] = tz_counts.get(tz, 0) + 1
        lg = u["lang"] or "en"
        lang_counts[lg] = lang_counts.get(lg, 0) + 1

    countries_list = [
        {
            "code": code,
            "name_en": COUNTRY_NAMES.get(code, (code, code))[0],
            "name_zh": COUNTRY_NAMES.get(code, (code, code))[1],
            "count": cnt,
            "pct": round(cnt / denom_users * 100, 1),
        }
        for code, cnt in sorted(country_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    timezones_list = [
        {
            "timezone": tz,
            "count": cnt,
            "pct": round(cnt / denom_users * 100, 1),
        }
        for tz, cnt in sorted(tz_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:8]
    ]
    languages_list = [
        {
            "lang": lg,
            "label": "中文 (zh)" if lg == "zh" else "English (en)",
            "count": cnt,
            "pct": round(cnt / denom_users * 100, 1),
        }
        for lg, cnt in sorted(lang_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    # ------------------------------------ 4. Events, Model Stability & Cost
    chat_events = [e for e in ops_events if e.get("kind") == "chat_turn"]
    ui_events = [e for e in ops_events if e.get("kind") == "ui_event"]
    rl_events = [e for e in ops_events if e.get("kind") == "rate_limit"]
    err_events = [e for e in ops_events if e.get("kind") == "system_error"]
    signin_events = [e for e in ops_events if e.get("kind") == "sign_in"]

    intent_counts: dict[str, int] = {
        "message": 0,
        "photo": 0,
        "confirm": 0,
        "reject": 0,
        "greeting": 0,
    }
    outcome_counts: dict[str, int] = {
        "ok": 0,
        "awaiting_confirmation": 0,
        "agent_error": 0,
        "error": 0,
    }
    latencies_all: list[int] = []
    latencies_by_intent: dict[str, list[int]] = {}
    est_input_tokens = 0
    est_output_tokens = 0
    cost_today_usd = 0.0
    cost_mtd_usd = 0.0
    tool_activity_steps = 0
    confirmations_requested = 0

    turns_by_day: dict[str, int] = {}
    cost_by_day: dict[str, float] = {}
    tokens_by_day: dict[str, int] = {}

    for ev in chat_events:
        intent = str(ev.get("intent") or "message")
        outcome = str(ev.get("outcome") or "ok")
        day_str = str(ev.get("day") or "")
        lat = int(ev.get("latency_ms") or 0)
        in_tok = int(ev.get("est_input_tokens") or 0)
        out_tok = int(ev.get("est_output_tokens") or 0)
        c_usd = float(ev.get("est_cost_usd") or 0.0)
        act_cnt = int(ev.get("activity_events") or 0)
        conf_cnt = int(ev.get("confirmation_events") or 0)

        intent_counts[intent] = intent_counts.get(intent, 0) + 1
        outcome_counts[outcome] = outcome_counts.get(outcome, 0) + 1
        latencies_all.append(lat)
        latencies_by_intent.setdefault(intent, []).append(lat)
        est_input_tokens += in_tok
        est_output_tokens += out_tok
        tool_activity_steps += act_cnt
        confirmations_requested += conf_cnt

        if day_str:
            turns_by_day[day_str] = turns_by_day.get(day_str, 0) + 1
            cost_by_day[day_str] = cost_by_day.get(day_str, 0.0) + c_usd
            tokens_by_day[day_str] = tokens_by_day.get(day_str, 0) + in_tok + out_tok
            if day_str == today_iso:
                cost_today_usd += c_usd
            if day_str.startswith(month_prefix):
                cost_mtd_usd += c_usd

    total_meals = sum(len(du.get("meal_dates", [])) for du in domain_users.values())
    total_workouts = sum(
        len(du.get("workout_dates", [])) for du in domain_users.values()
    )
    total_measurements = sum(
        int(du.get("measurement_count", 0)) for du in domain_users.values()
    )
    total_plans = sum(1 for du in domain_users.values() if du.get("has_plan"))
    total_reviews = sum(int(du.get("review_count", 0)) for du in domain_users.values())

    # If domain logs exist from earlier sessions before ops_events was active,
    # include baseline domain turn estimates so cost/model metrics are never zeroed out.
    total_turns = len(chat_events)
    ok_turns = outcome_counts.get("ok", 0)
    confirmation_turns = outcome_counts.get("awaiting_confirmation", 0)
    agent_error_turns = outcome_counts.get("agent_error", 0)
    system_error_turns = outcome_counts.get("error", 0)
    photo_turns = intent_counts.get("photo", 0)

    successful_turns = ok_turns + confirmation_turns
    success_rate_pct = (
        round(successful_turns / total_turns * 100, 1) if total_turns > 0 else 100.0
    )
    avg_cost_per_turn_usd = (
        round(cost_mtd_usd / total_turns, 5) if total_turns > 0 else 0.0
    )
    budget_used_pct = round(min(100.0, (cost_mtd_usd / MONTHLY_BUDGET_USD) * 100), 2)

    # ---------------------------------------------- 5. 14-day Growth & Cost Series
    growth_series: list[dict[str, Any]] = []
    daily_cost_series: list[dict[str, Any]] = []
    for i in range(days - 1, -1, -1):
        d_iso = (today_date - timedelta(days=i)).isoformat()
        day_dau = sum(1 for u in merged_users if d_iso in u["active_dates"])
        day_new = sum(1 for u in merged_users if u["first_day"] == d_iso)
        day_meals = sum(
            du.get("meal_dates", []).count(d_iso) for du in domain_users.values()
        )
        day_workouts = sum(
            du.get("workout_dates", []).count(d_iso) for du in domain_users.values()
        )
        day_turns = turns_by_day.get(d_iso, 0)
        growth_series.append(
            {
                "date": d_iso,
                "dau": day_dau,
                "new_users": day_new,
                "turns": day_turns,
                "meal_logs": day_meals,
                "workout_logs": day_workouts,
            }
        )
        daily_cost_series.append(
            {
                "date": d_iso,
                "cost_usd": round(cost_by_day.get(d_iso, 0.0), 4),
                "turns": day_turns,
                "tokens": tokens_by_day.get(d_iso, 0),
            }
        )

    # ---------------------------------------------- 6. Feature Usage
    ui_counts: dict[str, int] = {}
    tab_counts: dict[str, int] = {
        "today": 0,
        "coach": 0,
        "progress": 0,
        "plan": 0,
        "admin": 0,
    }
    for ev in ui_events:
        name = str(ev.get("name") or "")
        if name:
            ui_counts[name] = ui_counts.get(name, 0) + 1
        if name == "tab_view":
            tab = str(ev.get("tab") or "")
            if tab:
                tab_counts[tab] = tab_counts.get(tab, 0) + 1

    intent_denom = max(total_turns, 1)
    by_intent = [
        {
            "key": k,
            "count": v,
            "pct": round(v / intent_denom * 100, 1) if total_turns else 0.0,
        }
        for k, v in sorted(intent_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]
    by_ui_event = [
        {"name": k, "count": v}
        for k, v in sorted(ui_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:10]
    ]
    by_tab = [
        {"tab": k, "count": v}
        for k, v in sorted(tab_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    # ---------------------------------------------- 7. Conversion Funnel
    attempt_users = max(
        len(all_emails),
        len(merged_users) + waitlist_pending,
        len(merged_users) + len(signin_events),
    )
    authorized_count = max(len(merged_users), waitlist_approved)
    profiled_count = profiled_users
    first_log_count = sum(1 for u in merged_users if u["has_activity"])
    retained_count = d1_retained

    raw_stages = [
        ("attempt_or_visit", attempt_users),
        ("authorized_users", authorized_count),
        ("profile_completed", profiled_count),
        ("first_log_or_plan", first_log_count),
        ("engaged_multi_day", retained_count),
    ]
    top_count = max(attempt_users, 1)
    funnel: list[dict[str, Any]] = []
    prev_val = top_count
    for idx, (stage_key, val) in enumerate(raw_stages):
        pct_top = round(val / top_count * 100, 1) if attempt_users > 0 else 0.0
        conv_prev = (
            100.0
            if idx == 0
            else (round(val / max(prev_val, 1) * 100, 1) if prev_val > 0 else 0.0)
        )
        funnel.append(
            {
                "stage": stage_key,
                "count": val,
                "pct_of_top": min(100.0, pct_top),
                "conversion_from_prev_pct": min(100.0, conv_prev),
            }
        )
        prev_val = max(val, 1)

    # ---------------------------------------------- 8. User Feedback
    up_count = sum(1 for f in feedback_list if f.get("rating") == "up")
    down_count = sum(1 for f in feedback_list if f.get("rating") == "down")
    general_count = sum(1 for f in feedback_list if f.get("kind") == "general")
    rated_total = up_count + down_count
    satisfaction_pct = (
        round(up_count / rated_total * 100, 1) if rated_total > 0 else 100.0
    )
    tag_counts: dict[str, int] = {}
    for f in feedback_list:
        for tg in f.get("tags") or []:
            tag_counts[str(tg)] = tag_counts.get(str(tg), 0) + 1
    feedback_sorted = sorted(
        feedback_list, key=lambda f: str(f.get("created_at") or ""), reverse=True
    )
    recent_feedback = [
        {
            "created_at": str(f.get("created_at") or ""),
            "kind": str(f.get("kind") or "message"),
            "rating": f.get("rating"),
            "tags": list(f.get("tags") or []),
            "comment": str(f.get("comment") or ""),
            "page": str(f.get("page") or "coach"),
            "lang": str(f.get("lang") or "en"),
            "user": str(f.get("user") or ""),
        }
        for f in feedback_sorted[:15]
    ]

    # ---------------------------------------------- 9. System Stability
    sorted_lat = sorted(latencies_all)
    latency_overall = {
        "p50_ms": _percentile(sorted_lat, 0.50),
        "p95_ms": _percentile(sorted_lat, 0.95),
        "max_ms": sorted_lat[-1] if sorted_lat else 0,
        "avg_ms": int(sum(sorted_lat) / len(sorted_lat)) if sorted_lat else 0,
        "sample_count": len(sorted_lat),
    }
    latency_by_intent = []
    for intent_key, lats in sorted(latencies_by_intent.items()):
        s_lats = sorted(lats)
        latency_by_intent.append(
            {
                "intent": intent_key,
                "count": len(s_lats),
                "p50_ms": _percentile(s_lats, 0.50),
                "p95_ms": _percentile(s_lats, 0.95),
                "avg_ms": int(sum(s_lats) / len(s_lats)) if s_lats else 0,
            }
        )

    limits_cfg = default_limits()
    rl_by_scope_map: dict[str, int] = dict.fromkeys(limits_cfg, 0)
    for r in rl_events:
        sc = str(r.get("scope") or "")
        if sc:
            rl_by_scope_map[sc] = rl_by_scope_map.get(sc, 0) + 1
    rl_by_scope = [
        {
            "scope": sc,
            "blocked_count": cnt,
            "limit_max": limits_cfg[sc].max_hits if sc in limits_cfg else 0,
            "window_seconds": limits_cfg[sc].window_seconds if sc in limits_cfg else 0,
        }
        for sc, cnt in rl_by_scope_map.items()
    ]

    err_by_source: dict[str, int] = {}
    for err in err_events:
        src = str(err.get("source") or "unknown")
        err_by_source[src] = err_by_source.get(src, 0) + 1
    err_sorted = sorted(
        err_events, key=lambda e: str(e.get("created_at") or ""), reverse=True
    )
    recent_errors = [
        {
            "created_at": str(e.get("created_at") or ""),
            "source": str(e.get("source") or ""),
            "error": str(e.get("error") or ""),
            "user": str(e.get("user") or ""),
        }
        for e in err_sorted[:15]
    ]

    total_errors = len(err_events)
    if total_errors == 0 and success_rate_pct >= 95.0:
        sys_status = "healthy"
    elif success_rate_pct >= 80.0:
        sys_status = "degraded"
    else:
        sys_status = "critical"

    total_ops = max(total_turns + len(ui_events) + len(signin_events), 1)
    uptime_pct = round(max(0.0, 100.0 - (system_error_turns / total_ops * 100.0)), 2)

    analytics = build_analytics(
        users=merged_users,
        chat_events=chat_events,
        ui_events=ui_events,
        feedback=feedback_list,
        access_entries=access_entries,
        today=today_date,
        days=days,
    )

    return {
        "generated_at": now.isoformat(),
        "analytics": analytics,
        "summary": {
            "total_users": total_users,
            "profiled_users": profiled_users,
            "online_now_5m": online_5m,
            "active_15m": active_15m,
            "dau": dau,
            "wau": wau,
            "mau": mau,
            "stickiness_pct": stickiness_pct,
            "d1_retention_pct": d1_retention_pct,
            "d7_retention_pct": d7_retention_pct,
            "waitlist_pending": waitlist_pending,
            "waitlist_approved": waitlist_approved,
        },
        "growth_series": growth_series,
        "online_users": online_user_rows[:25],
        "geography": {
            "countries": countries_list,
            "timezones": timezones_list,
            "languages": languages_list,
        },
        "feature_usage": {
            "by_intent": by_intent,
            "by_domain": {
                "meals_logged": total_meals,
                "workouts_logged": total_workouts,
                "measurements_logged": total_measurements,
                "active_plans": total_plans,
                "weekly_reviews": total_reviews,
                "confirmations_requested": confirmations_requested,
            },
            "by_ui_event": by_ui_event,
            "by_tab": by_tab,
        },
        "funnel": funnel,
        "feedback": {
            "total": len(feedback_list),
            "up_count": up_count,
            "down_count": down_count,
            "general_count": general_count,
            "satisfaction_pct": satisfaction_pct,
            "tags": [
                {"tag": k, "count": v}
                for k, v in sorted(tag_counts.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
            "recent": recent_feedback,
        },
        "model_stability_and_cost": {
            "total_turns": total_turns,
            "ok_turns": ok_turns,
            "confirmation_turns": confirmation_turns,
            "agent_error_turns": agent_error_turns,
            "system_error_turns": system_error_turns,
            "photo_turns": photo_turns,
            "tool_activity_steps": tool_activity_steps,
            "success_rate_pct": success_rate_pct,
            "est_input_tokens": est_input_tokens,
            "est_output_tokens": est_output_tokens,
            "est_total_tokens": est_input_tokens + est_output_tokens,
            "cost_today_usd": round(cost_today_usd, 4),
            "cost_mtd_usd": round(cost_mtd_usd, 4),
            "avg_cost_per_turn_usd": avg_cost_per_turn_usd,
            "monthly_budget_usd": MONTHLY_BUDGET_USD,
            "budget_used_pct": budget_used_pct,
            "daily_cost_series": daily_cost_series,
        },
        "system_stability": {
            "status": sys_status,
            "uptime_pct": uptime_pct,
            "latency_overall": latency_overall,
            "latency_by_intent": latency_by_intent,
            "rate_limits": {
                "total_hits_blocked": len(rl_events),
                "by_scope": rl_by_scope,
            },
            "errors": {
                "total_errors": total_errors,
                "by_source": [
                    {"source": k, "count": v}
                    for k, v in sorted(
                        err_by_source.items(), key=lambda kv: (-kv[1], kv[0])
                    )
                ],
                "recent": recent_errors,
            },
            "runtime_info": {
                "agent_backend": settings.agent_backend,
                "agent_location": settings.agent_runtime_location,
                "is_cloud_run": settings.is_cloud_run,
                "storage_backend": os.environ.get(
                    "FITNESS_STORAGE_BACKEND", "firestore"
                ).lower(),
                "asset_version": asset_version,
            },
        },
        "access_control": {
            "admin_emails": sorted(settings.admin_emails),
            "static_allowed_emails": sorted(settings.allowed_emails),
            "entries": access_entries,
        },
    }
