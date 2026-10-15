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

"""Web app settings, read from environment variables (see ``web/.env.example``)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

# Hidden first message sent by the browser when a new conversation starts, so
# the coach runs its due check-ins (FR-8). It is never shown in the chat.
GREETING_TEXT = "Hi (opened the app)"

MAX_IMAGE_BYTES = 6 * 1024 * 1024
ALLOWED_IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")


def _bool(name: str, default: bool = False) -> bool:
    return os.environ.get(name, str(default)).strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _csv(name: str) -> frozenset[str]:
    raw = os.environ.get(name, "")
    return frozenset(item.strip().lower() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class WebSettings:
    """Runtime configuration for the web backend."""

    google_client_id: str = ""
    allowed_emails: frozenset[str] = field(default_factory=frozenset)
    session_secret: str = ""
    session_max_age_seconds: int = 7 * 24 * 3600
    session_idle_hours: float = 6.0
    dev_auth_bypass_requested: bool = False
    is_cloud_run: bool = False
    agent_backend: str = "local"
    local_agent_url: str = "http://localhost:8000"
    agent_app_name: str = "app"
    agent_runtime_project: str = ""
    agent_runtime_location: str = "us-east1"
    agent_runtime_resource: str = ""
    agent_timeout_seconds: float = 300.0

    @property
    def dev_auth_bypass(self) -> bool:
        """The local sign-in bypass is never active on Cloud Run."""
        return self.dev_auth_bypass_requested and not self.is_cloud_run

    @classmethod
    def from_env(cls) -> WebSettings:
        """Builds settings from the current process environment."""
        return cls(
            google_client_id=os.environ.get("GOOGLE_OAUTH_CLIENT_ID", ""),
            allowed_emails=_csv("ALLOWED_EMAILS"),
            session_secret=os.environ.get("SESSION_SECRET", ""),
            session_max_age_seconds=int(
                os.environ.get("SESSION_MAX_AGE_SECONDS", 7 * 24 * 3600)
            ),
            session_idle_hours=float(os.environ.get("SESSION_IDLE_HOURS", 6)),
            dev_auth_bypass_requested=_bool("DEV_AUTH_BYPASS"),
            is_cloud_run=bool(os.environ.get("K_SERVICE")),
            agent_backend=os.environ.get("AGENT_BACKEND", "local").strip().lower(),
            local_agent_url=os.environ.get(
                "LOCAL_AGENT_URL", "http://localhost:8000"
            ).rstrip("/"),
            agent_app_name=os.environ.get("AGENT_APP_NAME", "app"),
            agent_runtime_project=os.environ.get("GOOGLE_CLOUD_PROJECT", ""),
            agent_runtime_location=os.environ.get("AGENT_RUNTIME_LOCATION", "us-east1"),
            agent_runtime_resource=os.environ.get("AGENT_RUNTIME_RESOURCE", ""),
            agent_timeout_seconds=float(os.environ.get("AGENT_TIMEOUT_SECONDS", 300)),
        )
