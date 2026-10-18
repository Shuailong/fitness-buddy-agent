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

"""Progress dashboard data (FR-12).

Every number is computed by the same deterministic ``fitness_core`` functions
the agent tools use (``weight_trend``, ``daily_nutrition_summary``,
``weekly_progress_snapshot``) over the same repository, so the dashboard always
matches what the coach says in chat.
"""

from __future__ import annotations

import asyncio
import base64
import time
from datetime import date, timedelta
from typing import Any

from fitness_core.models import WEEKDAYS, utc_now
from fitness_core.nutrition import daily_nutrition_summary
from fitness_core.progress import user_local_date, weekly_progress_snapshot
from fitness_core.repository import FitnessRepository
from fitness_core.trends import weight_trend

NUTRITION_DAYS = 14
RANGE_DAYS = (14, 30, 90)
DEFAULT_RANGE_DAYS = 30
STREAK_LOOKBACK_DAYS = 120
WORKOUT_HISTORY_WEEKS = 4
_PHOTO_CHUNK_CHARS = 700_000


def _mem_photo_bucket(repo: Any) -> dict[tuple[str, str], tuple[str, bytes, float]]:
    bucket = getattr(repo, "_meal_photos", None)
    if bucket is None:
        bucket = {}
        repo._meal_photos = bucket
    return bucket


async def save_meal_photo(
    repo: Any, user_id: str, entry_id: str, mime: str, data: bytes
) -> None:
    """Persists a meal photo in memory and Firestore ``users/{uid}/meal_photos/{entry_id}``."""
    if not entry_id or not data:
        return
    _mem_photo_bucket(repo)[(user_id, entry_id)] = (mime, data, time.time())
    db = getattr(repo, "_db", None)
    if db is None:
        return
    try:
        col = db.collection("users").document(user_id).collection("meal_photos")
        b64 = base64.b64encode(data).decode("ascii")
        now_iso = utc_now().isoformat()
        if len(b64) <= _PHOTO_CHUNK_CHARS:
            await col.document(entry_id).set(
                {"mime": mime, "data_b64": b64, "updated_at": now_iso}
            )
        else:
            chunks = [
                b64[i : i + _PHOTO_CHUNK_CHARS]
                for i in range(0, len(b64), _PHOTO_CHUNK_CHARS)
            ]
            for idx, chunk in enumerate(chunks):
                await col.document(f"{entry_id}_part_{idx}").set({"data_b64": chunk})
            await col.document(entry_id).set(
                {"mime": mime, "chunk_count": len(chunks), "updated_at": now_iso}
            )
    except Exception:
        pass


async def get_meal_photo(
    repo: Any, user_id: str, entry_id: str
) -> tuple[str, bytes] | None:
    """Loads a stored meal photo ``(mime, raw_bytes)`` by ``entry_id``."""
    mem = _mem_photo_bucket(repo).get((user_id, entry_id))
    if mem is not None:
        return mem[0], mem[1]
    db = getattr(repo, "_db", None)
    if db is None:
        return None
    try:
        col = db.collection("users").document(user_id).collection("meal_photos")
        snap = await col.document(entry_id).get()
        if not snap.exists:
            return None
        doc = snap.to_dict() or {}
        mime = str(doc.get("mime") or "image/jpeg")
        if doc.get("data_b64"):
            raw = base64.b64decode(doc["data_b64"])
            _mem_photo_bucket(repo)[(user_id, entry_id)] = (mime, raw, time.time())
            return mime, raw
        chunk_count = int(doc.get("chunk_count") or 0)
        if chunk_count > 0:
            parts: list[str] = []
            for idx in range(chunk_count):
                part_snap = await col.document(f"{entry_id}_part_{idx}").get()
                if not part_snap.exists:
                    return None
                parts.append(str((part_snap.to_dict() or {}).get("data_b64") or ""))
            raw = base64.b64decode("".join(parts))
            _mem_photo_bucket(repo)[(user_id, entry_id)] = (mime, raw, time.time())
            return mime, raw
    except Exception:
        return None
    return None


async def save_pending_meal_photo(
    repo: Any, user_id: str, session_id: str, mime: str, data: bytes
) -> None:
    """Stores the most recent uploaded photo in a session so a subsequent meal log can claim it."""
    await save_meal_photo(repo, user_id, f"_pending_{session_id}", mime, data)


async def get_pending_meal_photo(
    repo: Any, user_id: str, session_id: str, max_age_s: float = 1800.0
) -> tuple[str, bytes] | None:
    """Returns the pending session photo if uploaded recently."""
    key = (user_id, f"_pending_{session_id}")
    mem = _mem_photo_bucket(repo).get(key)
    if mem is not None:
        if time.time() - mem[2] <= max_age_s:
            return mem[0], mem[1]
        return None
    return await get_meal_photo(repo, user_id, f"_pending_{session_id}")


def normalize_range(range_days: int | None) -> int:
    """Clamps a requested range to one of the supported windows (2W/1M/3M)."""
    if range_days in RANGE_DAYS:
        return int(range_days)
    return DEFAULT_RANGE_DAYS


def logging_streak(logged_dates: set[str], today: date) -> int:
    """Consecutive days with at least one meal logged, ending today.

    If nothing is logged yet today, the streak counts back from yesterday so a
    morning visit does not show a broken streak.
    """
    day = today if today.isoformat() in logged_dates else today - timedelta(days=1)
    streak = 0
    while day.isoformat() in logged_dates:
        streak += 1
        day -= timedelta(days=1)
    return streak


async def build_dashboard(
    repo: FitnessRepository,
    user_id: str,
    today: date | None = None,
    range_days: int | None = None,
) -> dict[str, Any]:
    """Builds the dashboard payload for one user.

    Args:
        repo: The fitness data repository.
        user_id: The signed-in user's ID (Google ``sub``).
        today: Override for "today" (defaults to today in the user's time zone).
        range_days: Window for the weight chart (14, 30 or 90 days). Nutrition
            always covers the last 14 days.

    Returns:
        A JSON-serializable dict with targets, weight trend, daily nutrition,
        today's meals and planned session, logging streak, workout completion,
        the current plan and the latest weekly review.
    """
    profile = await repo.get_profile(user_id)
    if profile is None:
        return {"has_profile": False}
    today = today or user_local_date(profile.timezone)
    range_days = normalize_range(range_days)
    first_day = today - timedelta(days=NUTRITION_DAYS - 1)
    range_start = today - timedelta(days=range_days - 1)
    history_start = today - timedelta(days=7 * WORKOUT_HISTORY_WEEKS - 1)

    plan, measurements, meals, workouts, review = await asyncio.gather(
        repo.get_current_plan(user_id),
        repo.list_measurements(user_id),
        repo.list_meals(
            user_id,
            start=(today - timedelta(days=STREAK_LOOKBACK_DAYS)).isoformat(),
            end=today.isoformat(),
        ),
        repo.list_workouts(
            user_id, start=history_start.isoformat(), end=today.isoformat()
        ),
        repo.latest_weekly_review(user_id),
    )

    trend = weight_trend(measurements, starting_weight_kg=profile.starting_weight_kg)
    days = [
        daily_nutrition_summary(
            (first_day + timedelta(days=i)).isoformat(), meals, profile.targets
        )
        for i in range(NUTRITION_DAYS)
    ]
    week_start = today - timedelta(days=6)
    week_workouts = [w for w in workouts if w.local_date >= week_start.isoformat()]
    snapshot = weekly_progress_snapshot(
        profile=profile,
        plan=plan,
        workouts=week_workouts,
        meals=[m for m in meals if m.local_date >= week_start.isoformat()],
        measurements=measurements,
        week_end=today,
    )
    week_dates = {w.local_date for w in week_workouts}
    weekday = WEEKDAYS[today.weekday()]
    today_session = (
        next((s for s in plan.sessions if s.day_of_week == weekday), None)
        if plan
        else None
    )
    meals_today = sorted(
        (m for m in meals if m.local_date == today.isoformat()),
        key=lambda m: m.logged_at,
    )
    workout_history = []
    for week in range(WORKOUT_HISTORY_WEEKS - 1, -1, -1):
        end = today - timedelta(days=7 * week)
        start = end - timedelta(days=6)
        workout_history.append(
            {
                "week_start": start.isoformat(),
                "week_end": end.isoformat(),
                "sessions": len(
                    {
                        w.local_date
                        for w in workouts
                        if start.isoformat() <= w.local_date <= end.isoformat()
                    }
                ),
            }
        )

    mem_photos = _mem_photo_bucket(repo)
    meals_today_payload: list[dict[str, Any]] = []
    for m in meals_today:
        has_photo = m.source == "photo" or (user_id, m.entry_id) in mem_photos
        meals_today_payload.append(
            {
                "entry_id": m.entry_id,
                "meal_type": m.meal_type,
                "logged_at": m.logged_at.isoformat(),
                "items": [i.name for i in m.items],
                "item_details": [i.model_dump(mode="json") for i in m.items],
                "totals": m.totals.model_dump(mode="json"),
                "source": m.source,
                "is_estimate": m.is_estimate,
                "photo_url": f"/api/meals/{m.entry_id}/photo" if has_photo else None,
            }
        )

    return {
        "has_profile": True,
        "today": today.isoformat(),
        "weekday": weekday,
        "timezone": profile.timezone,
        "goal": profile.goal,
        "range_days": range_days,
        "targets": profile.targets.model_dump(mode="json") if profile.targets else None,
        "weight": {
            "points": [
                p.model_dump(mode="json")
                for p in trend.points
                if p.local_date >= range_start.isoformat()
            ],
            **trend.model_dump(mode="json", exclude={"points"}),
        },
        "nutrition": {
            "days": [
                {
                    "local_date": d.local_date,
                    "meals_logged": d.meals_logged,
                    "calories_kcal": d.consumed.calories_kcal,
                    "protein_g": d.consumed.protein_g,
                    "carbs_g": d.consumed.carbs_g,
                    "fat_g": d.consumed.fat_g,
                    "target_calories_kcal": d.target_calories_kcal,
                    "target_protein_g": d.target_protein_g,
                    "protein_target_hit": d.protein_target_hit,
                }
                for d in days
            ],
            "days_logged": sum(1 for d in days if d.meals_logged),
            "protein_hit_days": sum(1 for d in days if d.protein_target_hit),
            "today": days[-1].model_dump(mode="json"),
            "meals_today": meals_today_payload,
            "logging_streak_days": logging_streak({m.local_date for m in meals}, today),
        },
        "week": {
            **snapshot.model_dump(mode="json"),
            "workout_dates": sorted(week_dates),
            "history": workout_history,
        },
        "plan": plan.model_dump(mode="json") if plan else None,
        "today_session": today_session.model_dump(mode="json")
        if today_session
        else None,
        "today_session_done": today.isoformat() in week_dates,
        "latest_review": review.model_dump(mode="json") if review else None,
    }
