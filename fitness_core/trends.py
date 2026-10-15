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

"""Body-weight trends: 7-day moving average and period comparisons."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, timedelta

from pydantic import BaseModel

from fitness_core.models import BodyMeasurement

MOVING_AVERAGE_DAYS = 7
LAST_MONTH_OFFSET_DAYS = 30


class TrendPoint(BaseModel):
    """One day in the weight series."""

    local_date: str
    weight_kg: float
    moving_average_kg: float


class MeasurementTrend(BaseModel):
    """Weight trend with comparisons to the start and to last month."""

    points: list[TrendPoint]
    latest_weight_kg: float | None = None
    latest_moving_average_kg: float | None = None
    starting_weight_kg: float | None = None
    change_since_start_kg: float | None = None
    moving_average_last_month_kg: float | None = None
    change_vs_last_month_kg: float | None = None
    latest_body_fat_percent: float | None = None
    latest_waist_cm: float | None = None


def _daily_weights(measurements: Iterable[BodyMeasurement]) -> dict[date, float]:
    """Keeps the latest weight per day."""
    latest: dict[date, BodyMeasurement] = {}
    for m in measurements:
        if m.weight_kg is None:
            continue
        day = date.fromisoformat(m.local_date)
        if day not in latest or m.measured_at > latest[day].measured_at:
            latest[day] = m
    return {d: m.weight_kg for d, m in latest.items() if m.weight_kg is not None}


def _window_average(daily: dict[date, float], end: date) -> float | None:
    window = [w for d, w in daily.items() if end - timedelta(days=MOVING_AVERAGE_DAYS - 1) <= d <= end]
    return round(sum(window) / len(window), 2) if window else None


def weight_trend(
    measurements: Iterable[BodyMeasurement], starting_weight_kg: float | None = None
) -> MeasurementTrend:
    """Computes the weight series with a trailing 7-day moving average.

    Args:
        measurements: All body measurements for the user.
        starting_weight_kg: Weight recorded at onboarding; used as the start
            value when it predates the first measurement.

    Returns:
        The trend series and summary comparisons.
    """
    measurements = list(measurements)
    daily = _daily_weights(measurements)
    days = sorted(daily)
    points = [
        TrendPoint(
            local_date=d.isoformat(),
            weight_kg=daily[d],
            moving_average_kg=_window_average(daily, d) or daily[d],
        )
        for d in days
    ]
    trend = MeasurementTrend(points=points)

    with_fat = [m for m in measurements if m.body_fat_percent is not None]
    with_waist = [m for m in measurements if m.waist_cm is not None]
    if with_fat:
        trend.latest_body_fat_percent = max(with_fat, key=lambda m: m.measured_at).body_fat_percent
    if with_waist:
        trend.latest_waist_cm = max(with_waist, key=lambda m: m.measured_at).waist_cm

    start = starting_weight_kg if starting_weight_kg is not None else (daily[days[0]] if days else None)
    trend.starting_weight_kg = start
    if not days:
        return trend

    last = days[-1]
    trend.latest_weight_kg = daily[last]
    trend.latest_moving_average_kg = _window_average(daily, last)
    if start is not None and trend.latest_moving_average_kg is not None:
        trend.change_since_start_kg = round(trend.latest_moving_average_kg - start, 2)
    month_ago = _window_average(daily, last - timedelta(days=LAST_MONTH_OFFSET_DAYS))
    trend.moving_average_last_month_kg = month_ago
    if month_ago is not None and trend.latest_moving_average_kg is not None:
        trend.change_vs_last_month_kg = round(trend.latest_moving_average_kg - month_ago, 2)
    return trend
