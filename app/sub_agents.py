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

"""Specialist agents delegated to by the coordinator (NFR-O1, NFR-O2).

Pattern: Coordinator + task-mode specialists (ADK 2.x structured delegation).
The coordinator calls each specialist as a tool named after it; the specialist
may ask the user follow-up questions and must finish with ``finish_task``,
whose arguments are validated against its ``output_schema``.

The workout planner implements an evaluator-optimizer loop: draft ->
deterministic validation -> ``plan_critic`` review (single-turn, Flash-Lite)
-> refine, bounded by ``PLANNER_MAX_CRITIQUE_ROUNDS``.
"""

import logging

from google.adk.agents import Agent
from google.adk.agents.callback_context import CallbackContext
from google.genai import types

from app.config import MODELS, SETTINGS, THINKING, gemini, thinking_config
from app.observability.structured_logging import log_event
from app.prompts import (
    NUTRITION_INSTRUCTION,
    PLAN_CRITIC_INSTRUCTION,
    PLANNER_INSTRUCTION,
    REVIEWER_INSTRUCTION,
)
from app.schemas import MealLogResult, PlanCritique, PlanTaskResult, WeeklyReview
from app.tools._common import storage_user_id
from app.tools.context_tools import inject_local_date
from app.tools.logging_tools import get_body_measurement_trend, list_recent_log_entries
from app.tools.memory_tools import inject_coach_memory
from app.tools.nutrition_tools import get_daily_nutrition_summary, log_meal_entry
from app.tools.planning_tools import (
    get_current_training_plan,
    save_weekly_training_plan,
    search_exercise_library,
    validate_training_plan_constraints,
)
from app.tools.profile_tools import get_fitness_profile
from app.tools.progress_tools import get_weekly_progress_snapshot
from fitness_core.models import WeeklyReviewRecord, utc_now
from fitness_core.repository import get_repository, new_entry_id

WEEKLY_REVIEW_STATE_KEY = "latest_weekly_review"

plan_critic = Agent(
    name="plan_critic",
    model=gemini(MODELS.critic),
    mode="single_turn",
    description=(
        "Reviews a draft weekly training plan for balance, progression, goal fit, "
        "time realism and injury safety. Pass the full draft plan JSON and the user's "
        "goal and constraints in the request."
    ),
    instruction=PLAN_CRITIC_INSTRUCTION,
    output_schema=PlanCritique,
    generate_content_config=types.GenerateContentConfig(temperature=0.2),
    disallow_transfer_to_parent=True,
    disallow_transfer_to_peers=True,
)

workout_planner = Agent(
    name="workout_planner",
    model=gemini(MODELS.planner),
    mode="task",
    description=(
        "Creates or adjusts the user's weekly training plan from their goal, schedule, "
        "equipment and injuries, validates it, gets it reviewed, and saves it after the "
        "user confirms. Include the user's request and relevant context."
    ),
    instruction=PLANNER_INSTRUCTION.replace(
        "{max_rounds}", str(SETTINGS.planner_max_critique_rounds)
    ),
    output_schema=PlanTaskResult,
    generate_content_config=types.GenerateContentConfig(
        thinking_config=thinking_config(THINKING.planner)
    ),
    tools=[
        get_fitness_profile,
        get_current_training_plan,
        search_exercise_library,
        validate_training_plan_constraints,
        save_weekly_training_plan,
    ],
    sub_agents=[plan_critic],
    before_model_callback=[inject_coach_memory, inject_local_date],
)

nutrition_coach = Agent(
    name="nutrition_coach",
    model=gemini(MODELS.nutrition),
    mode="task",
    description=(
        "Logs meals from a photo or description (any cuisine) with per-item calorie and "
        "macro estimates, reports today's remaining calories and protein, and suggests "
        "what to eat within the remaining budget."
    ),
    instruction=NUTRITION_INSTRUCTION,
    output_schema=MealLogResult,
    tools=[
        get_fitness_profile,
        log_meal_entry,
        get_daily_nutrition_summary,
        list_recent_log_entries,
    ],
    before_model_callback=[inject_coach_memory, inject_local_date],
)


async def persist_weekly_review(callback_context: CallbackContext) -> None:
    """``after_agent_callback``: store the reviewer's structured output (no LLM involved)."""
    raw = callback_context.state.get(WEEKLY_REVIEW_STATE_KEY)
    if not raw:
        return None
    try:
        review = WeeklyReview.model_validate(raw)
        user_key = storage_user_id(callback_context)
        await get_repository().add_weekly_review(
            user_key,
            WeeklyReviewRecord(
                entry_id=new_entry_id(),
                user_id=user_key,
                week_start=review.week_start,
                week_end=review.week_end,
                created_at=utc_now(),
                summary=review.headline,
                proposed_daily_calories_kcal=next(
                    (
                        p.proposed_daily_calories_kcal
                        for p in review.proposals
                        if p.proposed_daily_calories_kcal
                    ),
                    None,
                ),
            ),
        )
    except Exception as exc:
        log_event(
            "weekly_review_persist_failed",
            severity=logging.WARNING,
            error_type=type(exc).__name__,
        )
    return None


weekly_reviewer = Agent(
    name="weekly_reviewer",
    model=gemini(MODELS.reviewer),
    mode="single_turn",
    description=(
        "Analyzes the user's last 7 days (workout completion, calories vs. target, "
        "protein, weight trend) and proposes safe adjustments. Never changes data."
    ),
    instruction=REVIEWER_INSTRUCTION,
    output_schema=WeeklyReview,
    output_key=WEEKLY_REVIEW_STATE_KEY,
    disallow_transfer_to_parent=True,
    disallow_transfer_to_peers=True,
    tools=[
        get_fitness_profile,
        get_weekly_progress_snapshot,
        get_body_measurement_trend,
    ],
    before_model_callback=inject_local_date,
    after_agent_callback=persist_weekly_review,
)
