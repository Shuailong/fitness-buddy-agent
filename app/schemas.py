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

"""Explicit JSON schemas for tool inputs and specialist outputs (NFR-T3).

Tool arguments are validated by ADK against these Pydantic models before the
tool body runs, and task-mode specialists must return their typed output via
``finish_task``, whose parameters are generated from the ``output_schema``.
"""

from typing import Literal

from pydantic import Field

from fitness_core.models import (
    Equipment,
    FitnessGoal,
    InjuryArea,
    MealItem,
    MealTotals,
    MealType,
    Sex,
    StrictModel,
    Weekday,
)
from fitness_core.units import LengthUnit, WeightUnit


class FitnessProfileInput(StrictModel):
    """Onboarding answers. Units are normalized to metric by the tool."""

    goal: FitnessGoal = Field(description="Primary goal.")
    sex: Sex = Field(description="Biological sex, used for the BMR formula and calorie floor.")
    age: int = Field(ge=16, le=90, description="Age in years. Users under 16 are not supported.")
    height_value: float = Field(gt=0, description="Height as stated by the user.")
    height_unit: LengthUnit = Field(default="cm", description="Unit of height_value.")
    weight_value: float = Field(gt=0, description="Current body weight as stated by the user.")
    weight_unit: WeightUnit = Field(default="kg", description="Unit of weight_value; 'jin' is 0.5 kg.")
    body_fat_percent: float | None = Field(default=None, ge=3, le=60)
    waist_value: float | None = Field(default=None, gt=0)
    waist_unit: LengthUnit = Field(default="cm")
    training_days_per_week: int = Field(ge=1, le=7)
    minutes_per_session: int = Field(ge=15, le=180)
    preferred_training_days: list[Weekday] = Field(default_factory=list)
    equipment: list[Equipment] = Field(
        default_factory=lambda: ["bodyweight"], description="All equipment the user can access."
    )
    dietary_preferences: list[str] = Field(default_factory=list, description="e.g. 'vegetarian', 'no pork'.")
    allergies: list[str] = Field(default_factory=list)
    injuries: list[str] = Field(default_factory=list, description="Injuries in the user's words.")
    injury_areas: list[InjuryArea] = Field(
        default_factory=list, description="Body areas affected by the injuries, mapped from 'injuries'."
    )
    timezone: str = Field(default="UTC", description="IANA time zone, e.g. 'Asia/Shanghai'.")


class MealLogResult(StrictModel):
    """Typed result the nutrition coach returns to the coordinator."""

    status: Literal["logged", "needs_user_input", "not_food", "failed"]
    entry_id: str | None = None
    meal_type: MealType | None = None
    items: list[MealItem] = Field(default_factory=list)
    meal_totals: MealTotals | None = None
    remaining_calories_kcal: float | None = None
    remaining_protein_g: float | None = None
    note_for_user: str = Field(default="", max_length=400, description="Short note, e.g. estimate caveats.")


class PlanTaskResult(StrictModel):
    """Typed result the workout planner returns to the coordinator."""

    status: Literal["saved", "rejected_by_user", "needs_user_input", "failed"]
    plan_title: str | None = None
    sessions_per_week: int | None = None
    summary_for_user: str = Field(max_length=1200, description="Day-by-day overview of the plan.")


class PlanCritique(StrictModel):
    """Structured self-critique of a draft training plan."""

    grade: Literal["pass", "revise"]
    issues: list[str] = Field(default_factory=list, max_length=8)
    suggested_changes: list[str] = Field(default_factory=list, max_length=8)


class AdjustmentProposal(StrictModel):
    """A single adjustment proposed by the weekly reviewer."""

    kind: Literal["calorie_target", "training", "habit"]
    proposal: str = Field(max_length=300)
    rationale: str = Field(max_length=300)
    proposed_daily_calories_kcal: int | None = Field(
        default=None, description="Only for kind='calorie_target'. Must respect the safety floor."
    )


class WeeklyReview(StrictModel):
    """Typed weekly review returned by the weekly reviewer (never writes data)."""

    week_start: str
    week_end: str
    headline: str = Field(max_length=160)
    wins: list[str] = Field(default_factory=list, max_length=5)
    concerns: list[str] = Field(default_factory=list, max_length=5)
    proposals: list[AdjustmentProposal] = Field(default_factory=list, max_length=4)
