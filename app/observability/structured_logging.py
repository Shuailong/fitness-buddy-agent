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

"""Structured JSON logging (NFR-B1).

Logs are emitted as one JSON object per line via ``google-cloud-logging``'s
``StructuredLogHandler``. Cloud Run and Agent Runtime ingest stdout JSON as
structured log entries (severity, labels, jsonPayload) and correlate them with
Cloud Trace automatically, without any Logging API call on the hot path.
"""

import logging
import os
from typing import Any

_CONFIGURED = False
LOGGER_NAME = "fitness_buddy"


def setup_structured_logging() -> logging.Logger:
    """Configures the ``fitness_buddy`` logger to emit structured JSON (idempotent)."""
    global _CONFIGURED
    logger = logging.getLogger(LOGGER_NAME)
    if _CONFIGURED:
        return logger
    try:
        from google.cloud.logging_v2.handlers import StructuredLogHandler

        handler: logging.Handler = StructuredLogHandler(
            labels={"service": "fitness-buddy-agent"},
            project_id=os.environ.get("GOOGLE_CLOUD_PROJECT"),
        )
    except ImportError:  # pragma: no cover - dependency is always installed
        handler = logging.StreamHandler()
    logger.handlers = [handler]
    logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))
    logger.propagate = False
    _CONFIGURED = True
    return logger


def log_event(event: str, severity: int = logging.INFO, **fields: Any) -> None:
    """Writes one structured log entry: ``{"event": ..., **fields}``.

    Callers must pass already-redacted values for any free text.

    Args:
        event: Stable event name, e.g. ``tool_intent`` or ``tool_outcome``.
        severity: Python logging level.
        **fields: JSON-serializable metadata.
    """
    logger = setup_structured_logging()
    logger.log(severity, event, extra={"json_fields": {"event": event, **fields}})
