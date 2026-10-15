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

"""Deterministic energy and macro targets with safety clamps.

Safety rules enforced in code (not only in prompts):

* SR-2: the daily calorie target never goes below the floor
  (1,200 kcal for women, 1,500 kcal for men).
* SR-3: the planned deficit never exceeds what would lose 1% of body weight per
  week (7,700 kcal per kg of body mass).
"""

from __future__ import annotations

import math

from fitness_core.models import EnergyTargets, FitnessGoal, Sex

CALORIE_FLOOR_KCAL: dict[str, int] = {"female": 1200, "male": 1500}
KCAL_PER_KG_BODY_MASS = 7700
MAX_WEEKLY_LOSS_FRACTION = 0.01
MAX_SURPLUS_FRACTION = 0.20

GOAL_CALORIE_ADJUSTMENT: dict[str, float] = {
    "fat_loss": -0.20,
    "muscle_gain": 0.10,
    "recomposition": -0.10,
    "general_fitness": 0.0,
}
PROTEIN_G_PER_KG: dict[str, float] = {
    "fat_loss": 2.0,
    "muscle_gain": 1.8,
    "recomposition": 2.0,
    "general_fitness": 1.6,
}
FAT_CALORIE_FRACTION = 0.25
MIN_FAT_G_PER_KG = 0.6


def mifflin_st_jeor_bmr(sex: Sex, weight_kg: float, height_cm: float, age: int) -> float:
    """Computes basal metabolic rate with the Mifflin-St Jeor equation.

    Args:
        sex: ``female`` or ``male``.
        weight_kg: Body weight in kilograms.
        height_cm: Height in centimeters.
        age: Age in years.

    Returns:
        BMR in kcal/day, rounded to 0.1.
    """
    sex_offset = 5 if sex == "male" else -161
    return round(10 * weight_kg + 6.25 * height_cm - 5 * age + sex_offset, 1)


def activity_factor(training_days_per_week: int) -> float:
    """Maps weekly training frequency to a standard TDEE activity multiplier.

    Args:
        training_days_per_week: Planned training days per week (0-7).

    Returns:
        The activity multiplier (1.2 sedentary to 1.725 very active).
    """
    if training_days_per_week <= 1:
        return 1.2
    if training_days_per_week <= 3:
        return 1.375
    if training_days_per_week <= 5:
        return 1.55
    return 1.725


def max_daily_deficit_kcal(weight_kg: float) -> int:
    """Largest daily deficit that keeps weight loss at or below 1% per week (SR-3).

    Args:
        weight_kg: Current body weight in kilograms.

    Returns:
        The maximum daily calorie deficit in kcal.
    """
    return math.floor(weight_kg * MAX_WEEKLY_LOSS_FRACTION * KCAL_PER_KG_BODY_MASS / 7)


def calculate_energy_targets(
    *,
    sex: Sex,
    age: int,
    height_cm: float,
    weight_kg: float,
    training_days_per_week: int,
    goal: FitnessGoal,
    requested_daily_calories_kcal: int | None = None,
) -> EnergyTargets:
    """Computes daily calorie and macro targets, applying the safety clamps.

    When ``requested_daily_calories_kcal`` is given (e.g. a coach or user
    proposal), it replaces the goal-based default but is still clamped by the
    1%-per-week rule, the calorie floor and a +20% surplus cap.

    Args:
        sex: ``female`` or ``male``.
        age: Age in years.
        height_cm: Height in centimeters.
        weight_kg: Current body weight in kilograms.
        training_days_per_week: Planned training days per week.
        goal: The user's fitness goal.
        requested_daily_calories_kcal: Optional explicit calorie target.

    Returns:
        The computed ``EnergyTargets``, including which clamps were applied.
    """
    bmr = mifflin_st_jeor_bmr(sex, weight_kg, height_cm, age)
    factor = activity_factor(training_days_per_week)
    tdee = round(bmr * factor, 1)

    if requested_daily_calories_kcal is None:
        target = tdee * (1 + GOAL_CALORIE_ADJUSTMENT[goal])
    else:
        target = float(requested_daily_calories_kcal)

    reasons: list[str] = []
    max_deficit = max_daily_deficit_kcal(weight_kg)
    min_by_loss_rate = tdee - max_deficit
    if target < min_by_loss_rate:
        target = min_by_loss_rate
        reasons.append("max_weight_loss_rate")
    floor = CALORIE_FLOOR_KCAL[sex]
    if target < floor:
        target = floor
        reasons.append("calorie_floor")
    max_by_surplus = tdee * (1 + MAX_SURPLUS_FRACTION)
    if target > max_by_surplus:
        target = max_by_surplus
        reasons.append("max_surplus")

    if "max_surplus" in reasons:
        daily = math.floor(target / 10) * 10
    elif reasons:
        # Round up so rounding never pushes the target back below a safety bound.
        daily = math.ceil(target / 10) * 10
    else:
        daily = round(target / 10) * 10

    protein = round(weight_kg * PROTEIN_G_PER_KG[goal])
    fat = max(round(daily * FAT_CALORIE_FRACTION / 9), round(weight_kg * MIN_FAT_G_PER_KG))
    carbs = max(0, round((daily - protein * 4 - fat * 9) / 4))

    return EnergyTargets(
        bmr_kcal=bmr,
        activity_factor=factor,
        tdee_kcal=tdee,
        daily_calories_kcal=int(daily),
        protein_g=protein,
        carbs_g=carbs,
        fat_g=fat,
        calorie_floor_kcal=floor,
        max_daily_deficit_kcal=max_deficit,
        clamped=bool(reasons),
        clamp_reasons=reasons,
    )
