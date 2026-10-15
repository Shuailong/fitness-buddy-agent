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

"""Unit normalization: every stored value is metric (kg, cm)."""

from __future__ import annotations

from typing import Literal

WeightUnit = Literal["kg", "lb", "jin"]
LengthUnit = Literal["cm", "in", "m"]

_KG_PER_UNIT: dict[str, float] = {
    "kg": 1.0,
    "lb": 0.45359237,
    # 1 jin (斤), the common Chinese market unit, is exactly 0.5 kg.
    "jin": 0.5,
}
_CM_PER_UNIT: dict[str, float] = {"cm": 1.0, "in": 2.54, "m": 100.0}


def to_kilograms(value: float, unit: WeightUnit) -> float:
    """Converts a body or load weight to kilograms, rounded to 0.1 kg.

    Args:
        value: The numeric weight as given by the user.
        unit: The unit of ``value``: ``kg``, ``lb`` or ``jin``.

    Returns:
        The weight in kilograms.

    Raises:
        ValueError: If the unit is unknown or the value is negative.
    """
    if unit not in _KG_PER_UNIT:
        raise ValueError(f"Unknown weight unit '{unit}'. Use one of kg, lb, jin.")
    if value < 0:
        raise ValueError("Weight cannot be negative.")
    return round(value * _KG_PER_UNIT[unit], 1)


def to_centimeters(value: float, unit: LengthUnit) -> float:
    """Converts a height or circumference to centimeters, rounded to 0.1 cm.

    Args:
        value: The numeric length as given by the user.
        unit: The unit of ``value``: ``cm``, ``in`` or ``m``.

    Returns:
        The length in centimeters.

    Raises:
        ValueError: If the unit is unknown or the value is negative.
    """
    if unit not in _CM_PER_UNIT:
        raise ValueError(f"Unknown length unit '{unit}'. Use one of cm, in, m.")
    if value < 0:
        raise ValueError("Length cannot be negative.")
    return round(value * _CM_PER_UNIT[unit], 1)
