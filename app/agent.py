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

"""Fitness Buddy: a multi-agent AI fitness coach built with ADK.

Architecture: Coordinator (``fitness_coach``, Flash) + task-mode specialists
(``workout_planner`` Pro, ``nutrition_coach`` Flash vision, ``weekly_reviewer``
Pro). Runner-wide plugins add Model Armor screening, a health-policy judge,
intent/outcome audit logging and tool retry. The App configures token-based
history compaction, context caching and resumable (human-in-the-loop) runs.
"""

import os

from google.adk.agents import Agent
from google.adk.agents.context_cache_config import ContextCacheConfig
from google.adk.apps import App, ResumabilityConfig
from google.adk.apps.app import EventsCompactionConfig
from google.adk.apps.llm_event_summarizer import LlmEventSummarizer
from google.adk.plugins import ReflectAndRetryToolPlugin
from google.adk.tools.preload_memory_tool import PreloadMemoryTool
from google.genai import types

from app.config import MODELS, SETTINGS, gemini
from app.memory.memory_bank import schedule_redacted_memory_ingest
from app.observability.structured_logging import setup_structured_logging
from app.plugins.health_policy_judge import HealthPolicyJudgePlugin
from app.plugins.intent_outcome_audit import IntentOutcomeAuditPlugin
from app.prompts import COACH_INSTRUCTION
from app.sub_agents import nutrition_coach, weekly_reviewer, workout_planner
from app.tools.logging_tools import (
    delete_logged_entry,
    get_body_measurement_trend,
    list_recent_log_entries,
    log_workout_session,
    record_body_measurement,
)
from app.tools.nutrition_tools import get_daily_nutrition_summary
from app.tools.planning_tools import get_current_training_plan
from app.tools.profile_tools import (
    calculate_daily_energy_targets,
    get_fitness_profile,
    save_fitness_profile,
    update_daily_calorie_target,
)
from app.tools.progress_tools import list_due_check_ins

setup_structured_logging()

root_agent = Agent(
    # Keep in sync with agents-cli-manifest.yaml (create_params.root_agent_name):
    # telemetry reports this as gen_ai.agent.name.
    name="fitness_coach",
    model=gemini(MODELS.coach),
    description="Head coach: onboarding, quick logging, check-ins, and delegation to specialists.",
    instruction=COACH_INSTRUCTION,
    tools=[
        PreloadMemoryTool(),
        list_due_check_ins,
        get_fitness_profile,
        save_fitness_profile,
        calculate_daily_energy_targets,
        update_daily_calorie_target,
        log_workout_session,
        record_body_measurement,
        get_body_measurement_trend,
        get_daily_nutrition_summary,
        get_current_training_plan,
        list_recent_log_entries,
        delete_logged_entry,
    ],
    sub_agents=[workout_planner, nutrition_coach, weekly_reviewer],
    generate_content_config=types.GenerateContentConfig(temperature=0.4),
    after_agent_callback=schedule_redacted_memory_ingest,
)


def _build_plugins() -> list:
    plugins: list = []
    if SETTINGS.model_armor_enabled:
        from app.plugins.model_armor_guard import ModelArmorGuardPlugin

        plugins.append(ModelArmorGuardPlugin())
    if SETTINGS.health_judge_enabled:
        plugins.append(HealthPolicyJudgePlugin())
    plugins.append(IntentOutcomeAuditPlugin())
    plugins.append(ReflectAndRetryToolPlugin(max_retries=2, throw_exception_if_retry_exceeded=False))
    return plugins


app = App(
    name="app",
    root_agent=root_agent,
    plugins=_build_plugins(),
    # Human-in-the-loop: runs pause on adk_request_confirmation and resume later.
    resumability_config=ResumabilityConfig(is_resumable=True),
    # Context bloat management: summarize older events once the prompt grows.
    events_compaction_config=EventsCompactionConfig(
        token_threshold=SETTINGS.compaction_token_threshold,
        event_retention_size=SETTINGS.compaction_retention_events,
        summarizer=LlmEventSummarizer(llm=gemini(MODELS.summarizer)),
    ),
    # Optional Gemini context caching of the long constitution prefix. Off by
    # default: cachedContents is not available for these models on the
    # `global` endpoint; enable it when serving from a supported region.
    context_cache_config=(
        ContextCacheConfig(min_tokens=4096, ttl_seconds=1800, cache_intervals=10)
        if os.getenv("CONTEXT_CACHE_ENABLED", "false").lower() == "true"
        else None
    ),
)
