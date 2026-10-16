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

"""Unit tests for the deterministic fitness core (no LLM involved)."""

from datetime import UTC, date, datetime, timedelta

import pytest

from fitness_core.energy import calculate_energy_targets, mifflin_st_jeor_bmr
from fitness_core.models import (
    BodyMeasurement,
    CheckInState,
    FitnessProfile,
    MealEntry,
    MealItem,
    PlannedExercise,
    PlannedSession,
    TrainingPlan,
    WorkoutSession,
    WorkoutSet,
)
from fitness_core.nutrition import daily_nutrition_summary, sum_meal_items
from fitness_core.plans import search_exercises, validate_training_plan
from fitness_core.progress import due_check_ins, weekly_progress_snapshot
from fitness_core.repository import InMemoryFitnessRepository
from fitness_core.trends import weight_trend
from fitness_core.units import to_centimeters, to_kilograms


def _profile(**overrides) -> FitnessProfile:
    data = {
        "user_id": "u1",
        "goal": "fat_loss",
        "sex": "male",
        "age": 35,
        "height_cm": 178,
        "starting_weight_kg": 82,
        "training_days_per_week": 3,
        "minutes_per_session": 45,
        "equipment": ["dumbbells", "pull_up_bar"],
        "injury_areas": ["knee"],
        "created_at": datetime(2026, 10, 1, tzinfo=UTC),
    }
    data.update(overrides)
    return FitnessProfile(**data)


def test_bmr_matches_spec_example():
    assert mifflin_st_jeor_bmr("male", 82, 178, 35) == 1762.5


def test_energy_targets_fat_loss_default():
    t = calculate_energy_targets(
        sex="male",
        age=35,
        height_cm=178,
        weight_kg=82,
        training_days_per_week=3,
        goal="fat_loss",
    )
    assert t.tdee_kcal == pytest.approx(2423.4, abs=0.1)
    assert t.daily_calories_kcal == 1940
    assert t.protein_g == 164
    assert not t.clamped


def test_calorie_floor_enforced_for_unsafe_request():
    t = calculate_energy_targets(
        sex="female",
        age=30,
        height_cm=160,
        weight_kg=55,
        training_days_per_week=2,
        goal="fat_loss",
        requested_daily_calories_kcal=800,
    )
    assert t.daily_calories_kcal >= 1200
    assert t.clamped
    assert (
        "calorie_floor" in t.clamp_reasons or "max_weight_loss_rate" in t.clamp_reasons
    )


def test_max_loss_rate_enforced():
    t = calculate_energy_targets(
        sex="male",
        age=35,
        height_cm=178,
        weight_kg=82,
        training_days_per_week=3,
        goal="fat_loss",
        requested_daily_calories_kcal=1500,
    )
    # TDEE 2423.4 - max deficit 902 = 1521.4 -> rounded up to 1530.
    assert t.daily_calories_kcal == 1530
    assert t.clamp_reasons == ["max_weight_loss_rate"]


def test_unit_conversion():
    assert to_kilograms(162, "jin") == 81.0
    assert to_kilograms(180, "lb") == 81.6
    assert to_centimeters(70, "in") == 177.8
    with pytest.raises(ValueError):
        to_kilograms(-1, "kg")


def test_meal_totals_and_daily_summary():
    item = MealItem(
        name="Beef noodle soup",
        portion_grams=550,
        calories_kcal=620,
        protein_g=32,
        carbs_g=75,
        fat_g=18,
    )
    totals = sum_meal_items([item, item])
    assert totals.calories_kcal == 1240
    targets = calculate_energy_targets(
        sex="male",
        age=35,
        height_cm=178,
        weight_kg=82,
        training_days_per_week=3,
        goal="fat_loss",
    )
    meal = MealEntry(
        entry_id="m1",
        user_id="u1",
        local_date="2026-10-15",
        logged_at=datetime.now(UTC),
        meal_type="lunch",
        items=[item],
        totals=sum_meal_items([item]),
    )
    s = daily_nutrition_summary("2026-10-15", [meal], targets)
    assert s.remaining_calories_kcal == 1940 - 620
    assert s.protein_target_hit is False


def test_weight_trend_moving_average():
    base = date(2026, 10, 1)
    ms = [
        BodyMeasurement(
            entry_id=str(i),
            user_id="u1",
            local_date=(base + timedelta(days=i)).isoformat(),
            measured_at=datetime(2026, 10, 1, tzinfo=UTC) + timedelta(days=i),
            weight_kg=82 - 0.1 * i,
        )
        for i in range(10)
    ]
    trend = weight_trend(ms, starting_weight_kg=82)
    assert trend.latest_weight_kg == pytest.approx(81.1)
    # Last 7 days: 81.7 .. 81.1 -> mean 81.4
    assert trend.latest_moving_average_kg == pytest.approx(81.4, abs=0.01)
    assert trend.change_since_start_kg == pytest.approx(-0.6, abs=0.01)


def _plan(exercises: list[PlannedExercise], day="monday") -> TrainingPlan:
    return TrainingPlan(
        title="Test",
        goal="fat_loss",
        sessions=[
            PlannedSession(
                day_of_week=day,
                focus="Full body",
                exercises=exercises,
                estimated_minutes=40,
            )
        ],
    )


def test_plan_validation_flags_equipment_and_injury():
    plan = _plan(
        [
            PlannedExercise(
                exercise_id="barbell_back_squat",
                name="Barbell Back Squat",
                sets=3,
                reps=8,
            ),
            PlannedExercise(
                exercise_id="goblet_squat", name="Goblet Squat", sets=3, reps=10
            ),
        ]
    )
    result = validate_training_plan(plan, _profile())
    rules = {v.rule for v in result.violations}
    assert "missing_equipment" in rules  # no barbell
    assert "injury_conflict" in rules  # knee
    assert not result.is_valid


def test_plan_validation_passes_safe_plan():
    plan = _plan(
        [
            PlannedExercise(
                exercise_id="glute_bridge",
                name="Glute Bridge",
                sets=3,
                reps=12,
                rest_seconds=60,
            ),
            PlannedExercise(
                exercise_id="one_arm_dumbbell_row",
                name="Row",
                sets=3,
                reps=10,
                rest_seconds=60,
            ),
            PlannedExercise(
                exercise_id="dumbbell_floor_press",
                name="Floor Press",
                sets=3,
                reps=10,
                rest_seconds=60,
            ),
        ]
    )
    result = validate_training_plan(plan, _profile())
    assert result.is_valid, result.violations
    assert result.estimated_minutes_by_day["monday"] <= 45


def test_search_exercises_respects_equipment_and_injuries():
    names = {
        e.id
        for e in search_exercises(
            available_equipment=["dumbbells"], injury_areas=["knee"]
        )
    }
    assert "goblet_squat" not in names
    assert "pull_up" not in names
    assert "glute_bridge" in names


def test_due_check_ins_dedup_and_cap():
    profile = _profile()
    plan = TrainingPlan(
        title="P",
        goal="fat_loss",
        sessions=[
            PlannedSession(
                day_of_week=d,
                focus="x",
                estimated_minutes=30,
                exercises=[
                    PlannedExercise(
                        exercise_id="glute_bridge", name="GB", sets=2, reps=10
                    )
                ],
            )
            for d in ("monday", "tuesday", "wednesday")
        ],
    )
    today = date(2026, 10, 15)  # Thursday
    items = due_check_ins(
        profile=profile,
        plan=plan,
        workouts=[],
        measurements=[],
        latest_review_date=None,
        state=CheckInState(),
        today=today,
    )
    assert len(items) == 3
    again = due_check_ins(
        profile=profile,
        plan=plan,
        workouts=[],
        measurements=[],
        latest_review_date=None,
        state=CheckInState(raised_keys=[i.key for i in items]),
        today=today,
    )
    assert all(i.key not in {x.key for x in items} for i in again)


def test_weekly_snapshot_completion():
    profile = _profile(
        targets=calculate_energy_targets(
            sex="male",
            age=35,
            height_cm=178,
            weight_kg=82,
            training_days_per_week=3,
            goal="fat_loss",
        )
    )
    plan = _plan(
        [PlannedExercise(exercise_id="glute_bridge", name="GB", sets=2, reps=10)]
    )
    w = WorkoutSession(
        entry_id="w1",
        user_id="u1",
        local_date="2026-10-13",
        performed_at=datetime.now(UTC),
        exercises=[WorkoutSet(exercise_name="Glute Bridge", sets=2, reps=10)],
    )
    snap = weekly_progress_snapshot(
        profile=profile,
        plan=plan,
        workouts=[w],
        meals=[],
        measurements=[],
        week_end=date(2026, 10, 15),
    )
    assert snap.completed_sessions == 1
    assert snap.workout_completion_rate == 1.0


@pytest.mark.asyncio
async def test_in_memory_repository_isolation():
    repo = InMemoryFitnessRepository()
    await repo.save_profile(_profile(user_id="alice"))
    assert await repo.get_profile("bob") is None
    assert (await repo.get_profile("alice")).user_id == "alice"
