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

# ruff: noqa: RUF001 (Chinese sample data)
"""Demo mode: try the app without signing in.

``POST /auth/demo`` creates a throwaway account (``demo-<id>``) pre-filled with
a sample profile, weekly plan and two weeks of history, so the coach, meal
logging and the dashboard work right away. Demo accounts:

* expire after ``DEMO_TTL_S`` (the session cookie carries the expiry);
* have small daily quotas (see ``web.ratelimit``) plus a global daily cap;
* cannot use the live camera form coach;
* are deleted on "leave demo" and swept after expiry (``purge_expired``).
"""

from __future__ import annotations

import hashlib
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import Request

from fitness_core.energy import calculate_energy_targets
from fitness_core.memories import remember
from fitness_core.models import (
    BodyMeasurement,
    FitnessProfile,
    MealEntry,
    MealItem,
    PlannedExercise,
    PlannedSession,
    TrainingPlan,
    WorkoutSession,
    WorkoutSet,
)
from fitness_core.nutrition import sum_meal_items
from fitness_core.progress import user_local_date
from fitness_core.repository import new_entry_id

DEMO_TTL_S = 24 * 3600
DEMO_PREFIX = "demo-"
DEMO_EMAIL_DOMAIN = "demo.fitnessbuddy.local"
_REGISTRY = "demo_accounts"


def is_demo_user_id(user_id: str) -> bool:
    return user_id.startswith(DEMO_PREFIX)


def new_demo_identity(lang: str = "en") -> dict[str, Any]:
    """A fresh demo account for the session cookie."""
    demo_id = f"{DEMO_PREFIX}{uuid.uuid4().hex[:16]}"
    return {
        "sub": demo_id,
        "email": f"{demo_id}@{DEMO_EMAIL_DOMAIN}",
        "given_name": "体验用户" if lang == "zh" else "Guest",
        "picture": "",
        "demo": True,
        "demo_exp": int(time.time()) + DEMO_TTL_S,
    }


def client_ip_key(request: Request) -> str:
    """Pseudonymous per-IP key (first X-Forwarded-For hop on Cloud Run)."""
    forwarded = request.headers.get("x-forwarded-for", "")
    ip = (forwarded.split(",")[0].strip() if forwarded else "") or (
        request.client.host if request.client else "unknown"
    )
    return "demo-ip-" + hashlib.sha256(ip.encode()).hexdigest()[:16]


def _ex(
    exercise_id: str,
    name: str,
    sets: int,
    reps: int | None = None,
    *,
    seconds: int | None = None,
    rest: int = 75,
) -> PlannedExercise:
    return PlannedExercise(
        exercise_id=exercise_id,
        name=name,
        sets=sets,
        reps=reps,
        duration_seconds=seconds,
        rest_seconds=rest,
    )


def _plan(zh: bool) -> TrainingPlan:
    def n(cn: str, en: str) -> str:
        return cn if zh else en

    days = {
        "monday": (
            n("上肢推 + 核心", "Upper push + core"),
            [
                _ex(
                    "dumbbell_floor_press",
                    n("哑铃地板卧推", "Dumbbell Floor Press"),
                    3,
                    10,
                ),
                _ex(
                    "dumbbell_shoulder_press",
                    n("哑铃肩推", "Dumbbell Shoulder Press"),
                    3,
                    10,
                ),
                _ex("push_up", n("俯卧撑", "Push-Up"), 3, 10),
                _ex("dead_bug", n("死虫式", "Dead Bug"), 3, 12, rest=45),
            ],
        ),
        "wednesday": (
            n("下肢臀腿", "Legs & glutes"),
            [
                _ex("goblet_squat", n("高脚杯深蹲", "Goblet Squat"), 4, 12),
                _ex(
                    "dumbbell_romanian_deadlift",
                    n("哑铃罗马尼亚硬拉", "Dumbbell Romanian Deadlift"),
                    3,
                    10,
                ),
                _ex("reverse_lunge", n("反向弓步", "Reverse Lunge"), 3, 10),
                _ex("glute_bridge", n("臀桥", "Glute Bridge"), 3, 15, rest=45),
            ],
        ),
        "friday": (
            n("上肢拉 + 有氧", "Upper pull + cardio"),
            [
                _ex(
                    "one_arm_dumbbell_row",
                    n("单臂哑铃划船", "One-Arm Dumbbell Row"),
                    3,
                    10,
                ),
                _ex(
                    "dumbbell_biceps_curl", n("哑铃弯举", "Dumbbell Biceps Curl"), 3, 12
                ),
                _ex("bird_dog", n("鸟狗式", "Bird Dog"), 3, 10, rest=45),
                _ex("brisk_walk", n("快走", "Brisk Walk"), 1, seconds=900, rest=0),
            ],
        ),
    }
    return TrainingPlan(
        title=n("3 天居家哑铃减脂计划", "3-day home dumbbell fat-loss plan"),
        goal="fat_loss",
        sessions=[
            PlannedSession(
                day_of_week=day, focus=focus, exercises=exercises, estimated_minutes=40
            )
            for day, (focus, exercises) in days.items()
        ],
        progression_notes=n(
            "每组都能标准完成时，下次加 1-2 次或换重一点的哑铃。",
            "When every set feels clean, add 1-2 reps or a heavier dumbbell next time.",
        ),
    )


def _meal(
    user_id: str, day: str, meal_type: str, when: datetime, items: list[MealItem]
) -> MealEntry:
    return MealEntry(
        entry_id=new_entry_id(),
        user_id=user_id,
        local_date=day,
        logged_at=when,
        meal_type=meal_type,
        items=items,
        totals=sum_meal_items(items),
        source="text",
    )


async def seed_demo_account(repo: Any, user_id: str, lang: str, timezone: str) -> None:
    """Fills a demo account with a realistic sample: profile, plan, 2 weeks of logs."""
    zh = lang == "zh"
    timezone = timezone or ("Asia/Shanghai" if zh else "UTC")
    today = user_local_date(timezone)
    now = datetime.now(UTC)
    weight = 68.0
    targets = calculate_energy_targets(
        sex="female",
        age=30,
        height_cm=165,
        weight_kg=weight,
        training_days_per_week=3,
        goal="fat_loss",
    )
    await repo.save_profile(
        FitnessProfile(
            user_id=user_id,
            goal="fat_loss",
            sex="female",
            age=30,
            height_cm=165,
            starting_weight_kg=weight,
            training_days_per_week=3,
            minutes_per_session=45,
            equipment=["dumbbells"],
            timezone=timezone,
            targets=targets,
        )
    )
    await repo.save_current_plan(user_id, _plan(zh))

    def iso(days_ago: int) -> str:
        return (today - timedelta(days=days_ago)).isoformat()

    for i in range(13, 0, -1):  # a gentle downward trend with daily noise
        noise = ((i * 37) % 7 - 3) * 0.06
        await repo.add_entry(
            user_id,
            "measurement",
            BodyMeasurement(
                entry_id=new_entry_id(),
                user_id=user_id,
                local_date=iso(i),
                measured_at=now - timedelta(days=i),
                weight_kg=round(weight - (13 - i) * 0.07 + noise, 1),
            ),
        )
    sample_days = {
        1: [
            (
                "breakfast",
                "燕麦酸奶杯配蓝莓" if zh else "Oat & yogurt bowl with blueberries",
                320,
                18,
                45,
                8,
            ),
            (
                "lunch",
                "鸡胸肉糙米饭配西兰花" if zh else "Chicken, brown rice & broccoli",
                560,
                45,
                60,
                12,
            ),
            (
                "dinner",
                "清蒸鱼、青菜和半碗米饭"
                if zh
                else "Steamed fish, greens, half a bowl of rice",
                480,
                38,
                42,
                14,
            ),
        ],
        2: [
            (
                "breakfast",
                "全麦三明治配鸡蛋" if zh else "Whole-wheat egg sandwich",
                380,
                20,
                40,
                14,
            ),
            ("lunch", "牛肉面" if zh else "Beef noodle soup", 650, 32, 80, 18),
            (
                "dinner",
                "番茄炒蛋配杂粮饭" if zh else "Tomato egg stir-fry with mixed grains",
                520,
                22,
                62,
                18,
            ),
        ],
        3: [
            (
                "lunch",
                "沙拉配鸡腿肉" if zh else "Salad with chicken thigh",
                480,
                35,
                25,
                24,
            ),
            (
                "dinner",
                "麻辣烫（少油）" if zh else "Light malatang hot pot",
                620,
                30,
                70,
                20,
            ),
        ],
    }
    for days_ago, meals in sample_days.items():
        for idx, (meal_type, name, kcal, protein, carbs, fat) in enumerate(meals):
            item = MealItem(
                name=name,
                portion_grams=350,
                calories_kcal=kcal,
                protein_g=protein,
                carbs_g=carbs,
                fat_g=fat,
                confidence="medium",
            )
            await repo.add_entry(
                user_id,
                "meal",
                _meal(
                    user_id,
                    iso(days_ago),
                    meal_type,
                    now - timedelta(days=days_ago, hours=10 - idx * 4),
                    [item],
                ),
            )
    for days_ago, name, sets, reps, kg in (
        (2, "高脚杯深蹲" if zh else "Goblet Squat", 4, 12, 12),
        (5, "哑铃地板卧推" if zh else "Dumbbell Floor Press", 3, 10, 8),
    ):
        await repo.add_entry(
            user_id,
            "workout",
            WorkoutSession(
                entry_id=new_entry_id(),
                user_id=user_id,
                local_date=iso(days_ago),
                performed_at=now - timedelta(days=days_ago),
                exercises=[
                    WorkoutSet(exercise_name=name, sets=sets, reps=reps, weight_kg=kg)
                ],
                perceived_effort="moderate",
            ),
        )
    await remember(
        repo,
        user_id,
        "工作日晚上 7 点后才有时间训练"
        if zh
        else "Can only train after 7 pm on weekdays",
        category="schedule",
    )
    await remember(
        repo,
        user_id,
        "不太喜欢跑步，更喜欢快走" if zh else "Dislikes running, prefers brisk walking",
        category="preference",
    )


# ---------------------------------------------------------------- registry
async def register_demo(repo: Any, user_id: str) -> None:
    """Remembers a demo account so it can be swept after it expires."""
    record = {"user_id": user_id, "created_at": time.time()}
    db = getattr(repo, "_db", None)
    if db is not None:
        await db.collection(_REGISTRY).document(user_id).set(record)
        return
    registry: dict[str, dict[str, Any]] = getattr(repo, "demo_registry", None) or {}
    registry[user_id] = record
    repo.demo_registry = registry


async def forget_demo(repo: Any, user_id: str) -> None:
    db = getattr(repo, "_db", None)
    if db is not None:
        await db.collection(_REGISTRY).document(user_id).delete()
        return
    (getattr(repo, "demo_registry", None) or {}).pop(user_id, None)


async def expired_demo_ids(
    repo: Any, limit: int = 20, now: float | None = None
) -> list[str]:
    """Demo accounts older than their TTL (plus an hour of grace)."""
    cutoff = (now or time.time()) - DEMO_TTL_S - 3600
    db = getattr(repo, "_db", None)
    if db is not None:
        query = db.collection(_REGISTRY).where("created_at", "<", cutoff).limit(limit)
        return [doc.id async for doc in query.stream()]
    registry: dict[str, dict[str, Any]] = getattr(repo, "demo_registry", None) or {}
    return [uid for uid, r in registry.items() if r["created_at"] < cutoff][:limit]
