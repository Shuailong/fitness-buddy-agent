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

"""Pydantic domain models persisted in Firestore and rendered by the dashboard.

These are the canonical shapes of user data. Agent tools validate their inputs
and outputs against these models (or thin wrappers around them), so the LLM is
constrained by explicit JSON schemas end to end.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

FitnessGoal = Literal["fat_loss", "muscle_gain", "recomposition", "general_fitness"]
Sex = Literal["female", "male"]
Weekday = Literal[
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
]
WEEKDAYS: tuple[Weekday, ...] = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)
Equipment = Literal[
    "bodyweight",
    "dumbbells",
    "barbell",
    "kettlebell",
    "pull_up_bar",
    "resistance_bands",
    "bench",
    "cable_machine",
    "weight_machines",
    "treadmill",
    "stationary_bike",
    "rowing_machine",
    "jump_rope",
]
InjuryArea = Literal[
    "knee", "lower_back", "shoulder", "wrist", "ankle", "hip", "elbow", "neck"
]
PerceivedEffort = Literal["very_easy", "easy", "moderate", "hard", "very_hard"]
MealType = Literal["breakfast", "lunch", "dinner", "snack"]
EstimateConfidence = Literal["low", "medium", "high"]


def utc_now() -> datetime:
    """Returns the current time as a timezone-aware UTC datetime."""
    return datetime.now(UTC)


class StrictModel(BaseModel):
    """Base model that rejects unknown fields so LLM tool arguments stay exact."""

    model_config = ConfigDict(extra="forbid")


class EnergyTargets(StrictModel):
    """Daily energy and macro targets computed deterministically from a profile."""

    formula: str = Field(default="Mifflin-St Jeor", description="BMR formula used.")
    bmr_kcal: float = Field(description="Basal metabolic rate in kcal/day.")
    activity_factor: float = Field(description="Multiplier applied to BMR.")
    tdee_kcal: float = Field(description="Total daily energy expenditure in kcal/day.")
    daily_calories_kcal: int = Field(description="Daily calorie target in kcal.")
    protein_g: int = Field(description="Daily protein target in grams.")
    carbs_g: int = Field(description="Daily carbohydrate target in grams.")
    fat_g: int = Field(description="Daily fat target in grams.")
    calorie_floor_kcal: int = Field(
        description="Safety floor the calorie target may never go below."
    )
    max_daily_deficit_kcal: int = Field(
        description="Largest daily deficit allowed by the 1%-of-bodyweight-per-week rule."
    )
    clamped: bool = Field(
        description="True when a safety rule raised the target above what was requested."
    )
    clamp_reasons: list[str] = Field(
        default_factory=list,
        description="Which safety rules adjusted the target (e.g. 'calorie_floor').",
    )


class FitnessProfile(StrictModel):
    """A user's coaching profile collected during onboarding."""

    user_id: str
    goal: FitnessGoal
    sex: Sex
    age: int = Field(ge=16, le=90)
    height_cm: float = Field(ge=120, le=230)
    starting_weight_kg: float = Field(ge=30, le=250)
    body_fat_percent: float | None = Field(default=None, ge=3, le=60)
    waist_cm: float | None = Field(default=None, ge=40, le=200)
    training_days_per_week: int = Field(ge=1, le=7)
    minutes_per_session: int = Field(ge=15, le=180)
    preferred_training_days: list[Weekday] = Field(default_factory=list)
    equipment: list[Equipment] = Field(default_factory=lambda: ["bodyweight"])
    dietary_preferences: list[str] = Field(default_factory=list)
    allergies: list[str] = Field(default_factory=list)
    injuries: list[str] = Field(default_factory=list)
    injury_areas: list[InjuryArea] = Field(default_factory=list)
    timezone: str = Field(
        default="UTC", description="IANA time zone, e.g. Asia/Shanghai."
    )
    measurement_interval_days: int = Field(default=7, ge=1, le=31)
    targets: EnergyTargets | None = None
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


class WorkoutSet(StrictModel):
    """One exercise performed in a session, e.g. squat 5 x 5 at 60 kg."""

    exercise_name: str = Field(min_length=1, max_length=80)
    sets: int = Field(ge=1, le=20)
    reps: int | None = Field(default=None, ge=1, le=100)
    weight_kg: float | None = Field(default=None, ge=0, le=500)
    duration_seconds: int | None = Field(default=None, ge=1, le=14400)


class WorkoutSession(StrictModel):
    """A completed training session."""

    entry_id: str
    user_id: str
    local_date: str = Field(
        description="Session date in the user's time zone, YYYY-MM-DD."
    )
    performed_at: datetime
    exercises: list[WorkoutSet] = Field(min_length=1)
    perceived_effort: PerceivedEffort | None = None
    notes: str | None = Field(default=None, max_length=500)


class MealItem(StrictModel):
    """One food in a meal with estimated portion and macros."""

    name: str = Field(min_length=1, max_length=80)
    portion_grams: float = Field(gt=0, le=3000)
    calories_kcal: float = Field(ge=0, le=5000)
    protein_g: float = Field(ge=0, le=400)
    carbs_g: float = Field(ge=0, le=800)
    fat_g: float = Field(ge=0, le=400)
    confidence: EstimateConfidence = "medium"


class MealTotals(StrictModel):
    """Summed macros for a meal or a day."""

    calories_kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float


class MealEntry(StrictModel):
    """A logged meal. Per-item values are model estimates; totals are computed."""

    entry_id: str
    user_id: str
    local_date: str
    logged_at: datetime
    meal_type: MealType
    items: list[MealItem] = Field(min_length=1)
    totals: MealTotals
    is_estimate: bool = True
    source: Literal["photo", "text"] = "photo"


class BodyMeasurement(StrictModel):
    """A body measurement record normalized to metric units."""

    entry_id: str
    user_id: str
    local_date: str
    measured_at: datetime
    weight_kg: float | None = Field(default=None, ge=30, le=250)
    body_fat_percent: float | None = Field(default=None, ge=3, le=60)
    waist_cm: float | None = Field(default=None, ge=40, le=200)


class PlannedExercise(StrictModel):
    """An exercise prescription inside a planned session."""

    exercise_id: str = Field(description="ID from the exercise library.")
    name: str
    sets: int = Field(ge=1, le=10)
    reps: int | None = Field(
        default=None, ge=1, le=50, description="Target reps per set."
    )
    duration_seconds: int | None = Field(
        default=None,
        ge=10,
        le=3600,
        description="Work time per set for timed exercises.",
    )
    rest_seconds: int = Field(default=90, ge=0, le=600)
    target_rpe: int | None = Field(default=None, ge=1, le=10)
    notes: str | None = Field(default=None, max_length=200)


class PlannedSession(StrictModel):
    """One training day in a weekly plan."""

    day_of_week: Weekday
    focus: str = Field(max_length=60, description="e.g. 'Upper body push'.")
    exercises: list[PlannedExercise] = Field(min_length=1, max_length=12)
    estimated_minutes: int = Field(ge=5, le=240)


class TrainingPlan(StrictModel):
    """A weekly training plan produced by the workout planner."""

    plan_id: str | None = None
    title: str = Field(max_length=80)
    goal: FitnessGoal
    sessions: list[PlannedSession] = Field(min_length=1, max_length=7)
    progression_notes: str = Field(
        default="", max_length=600, description="How to progress week over week."
    )
    created_at: datetime | None = None


class WeeklyReviewRecord(StrictModel):
    """A stored weekly review produced by the weekly reviewer."""

    entry_id: str
    user_id: str
    week_start: str
    week_end: str
    created_at: datetime
    summary: str
    proposed_daily_calories_kcal: int | None = None


class CheckInState(StrictModel):
    """Which check-in items were already raised, to avoid repeating them."""

    raised_keys: list[str] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=utc_now)


MemoryCategory = Literal[
    "preference", "goal", "schedule", "training", "nutrition", "health", "other"
]


class UserMemory(StrictModel):
    """A durable, user-visible fact the coach remembers across conversations.

    Examples: "Prefers morning workouts", "Dislikes running", "Lactose
    intolerant", "Wants a direct, no-fluff coaching tone".
    """

    memory_id: str
    user_id: str
    text: str = Field(min_length=1, max_length=240)
    category: MemoryCategory = "other"
    source: Literal["coach", "user"] = "coach"
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
