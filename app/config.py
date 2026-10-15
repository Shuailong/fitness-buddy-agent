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

"""Runtime configuration, including strategic model routing (NFR-O2).

Each agent role is routed to the model tier that fits the work:

| Role                | Tier       | Why                                              |
|---------------------|------------|--------------------------------------------------|
| coach (root)        | Flash      | Fast, conversational routing and quick logging   |
| nutrition           | Flash      | Multimodal food recognition with low latency     |
| planner             | Pro        | Multi-constraint planning needs deeper reasoning |
| weekly reviewer     | Pro        | Trend analysis and trade-off reasoning           |
| plan critic         | Flash-Lite | Cheap, structured self-critique                  |
| safety judge        | Flash-Lite | Cheap, high-volume policy classification         |
| history summarizer  | Flash-Lite | Cheap context compaction                         |

Every model ID can be overridden with an environment variable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from google.adk.models import Gemini
from google.genai import types

# Shared retry policy for transient Gemini errors (429 / 5xx).
RETRY_OPTIONS = types.HttpRetryOptions(
    attempts=5, initial_delay=1.0, max_delay=30.0, exp_base=2.0, jitter=0.5
)


@dataclass(frozen=True)
class ModelRouting:
    """Model ID per agent role (strategic model routing)."""

    coach: str = field(default_factory=lambda: os.getenv("COACH_MODEL", "gemini-3.8-flash"))
    nutrition: str = field(default_factory=lambda: os.getenv("NUTRITION_MODEL", "gemini-3.8-flash"))
    planner: str = field(default_factory=lambda: os.getenv("PLANNER_MODEL", "gemini-3.1-pro-preview"))
    reviewer: str = field(default_factory=lambda: os.getenv("REVIEWER_MODEL", "gemini-3.1-pro-preview"))
    critic: str = field(default_factory=lambda: os.getenv("CRITIC_MODEL", "gemini-3.5-flash-lite"))
    safety_judge: str = field(default_factory=lambda: os.getenv("SAFETY_JUDGE_MODEL", "gemini-3.5-flash-lite"))
    summarizer: str = field(default_factory=lambda: os.getenv("SUMMARIZER_MODEL", "gemini-3.5-flash-lite"))


MODELS = ModelRouting()


def gemini(model_id: str) -> Gemini:
    """Builds a Gemini model with the shared retry policy."""
    return Gemini(model=model_id, retry_options=RETRY_OPTIONS)


def _flag(name: str, default: bool) -> bool:
    value = os.getenv(name)
    return default if value is None else value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    """Feature switches and service configuration read from the environment."""

    # Model Armor is regional; it needs its own location (not the Gemini 'global').
    model_armor_enabled: bool = field(default_factory=lambda: _flag("MODEL_ARMOR_ENABLED", False))
    model_armor_location: str = field(default_factory=lambda: os.getenv("MODEL_ARMOR_LOCATION", "us-east1"))
    model_armor_template_id: str = field(default_factory=lambda: os.getenv("MODEL_ARMOR_TEMPLATE_ID", "fitness-buddy-guard"))
    health_judge_enabled: bool = field(default_factory=lambda: _flag("HEALTH_JUDGE_ENABLED", True))
    # Cloud DLP (Sensitive Data Protection) for PII redaction; regex fallback otherwise.
    dlp_enabled: bool = field(default_factory=lambda: _flag("DLP_ENABLED", False))
    dlp_location: str = field(default_factory=lambda: os.getenv("DLP_LOCATION", "global"))
    # Explicit project ID for DLP / Model Armor resource paths. Agent Runtime
    # injects its own GOOGLE_CLOUD_PROJECT value, so allow an override.
    project_id: str = field(
        default_factory=lambda: os.getenv("FITNESS_GCP_PROJECT") or os.getenv("GOOGLE_CLOUD_PROJECT", "")
    )
    # Context management.
    compaction_token_threshold: int = field(default_factory=lambda: int(os.getenv("COMPACTION_TOKEN_THRESHOLD", "48000")))
    compaction_retention_events: int = field(default_factory=lambda: int(os.getenv("COMPACTION_RETENTION_EVENTS", "12")))
    planner_max_critique_rounds: int = field(default_factory=lambda: int(os.getenv("PLANNER_MAX_CRITIQUE_ROUNDS", "2")))


SETTINGS = Settings()
