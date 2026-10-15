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

"""Structured logging, PII redaction and tracing for the web backend (NFR-B1/B3/B4).

* Logs are one JSON object per line via ``StructuredLogHandler``; Cloud Run
  ingests them as structured entries correlated with Cloud Trace.
* User text is passed through :func:`redact_text` before it is logged. The
  regex set mirrors ``app/observability/pii_redaction.py``; it is duplicated
  here because importing ``app`` would load the whole agent into the web app.
* OpenTelemetry spans wrap every agent call. On Cloud Run, spans are exported
  to Cloud Trace when ``OTEL_TO_CLOUD=true``.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from opentelemetry import trace

LOGGER_NAME = "fitness_buddy.web"
_configured = False

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("EMAIL_ADDRESS", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("CREDIT_CARD_NUMBER", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    ("CHINA_RESIDENT_ID_NUMBER", re.compile(r"\b\d{17}[\dXx]\b")),
    (
        "PHONE_NUMBER",
        re.compile(
            r"(?<!\w)(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,4}\)?[ -]?)?\d{3,4}[ -]?\d{4}(?!\w)"
        ),
    ),
    ("IP_ADDRESS", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
]


def redact_text(text: str, max_length: int = 300) -> str:
    """Scrubs common PII patterns and truncates text before it is logged.

    Args:
        text: Free text that may contain PII.
        max_length: Maximum number of characters kept.

    Returns:
        The text with matches replaced by ``[INFO_TYPE]`` placeholders.
    """
    for info_type, pattern in _PATTERNS:
        text = pattern.sub(f"[{info_type}]", text)
    return text if len(text) <= max_length else text[:max_length] + "..."


def setup_logging() -> logging.Logger:
    """Configures the web logger to emit structured JSON (idempotent)."""
    global _configured
    logger = logging.getLogger(LOGGER_NAME)
    if _configured:
        return logger
    try:
        from google.cloud.logging_v2.handlers import StructuredLogHandler

        handler: logging.Handler = StructuredLogHandler(
            labels={"service": "fitness-buddy-web"},
            project_id=os.environ.get("GOOGLE_CLOUD_PROJECT"),
        )
    except ImportError:  # pragma: no cover - dependency is always installed
        handler = logging.StreamHandler()
    logger.handlers = [handler]
    logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))
    logger.propagate = False
    _configured = True
    return logger


def log_event(message: str, *, severity: int = logging.INFO, **fields: Any) -> None:
    """Writes one structured log entry with ``fields`` in ``jsonPayload``."""
    setup_logging().log(
        severity, message, extra={"json_fields": {"event": message, **fields}}
    )


def setup_tracing() -> None:
    """Exports spans to Cloud Trace when ``OTEL_TO_CLOUD=true`` (Cloud Run)."""
    if os.environ.get("OTEL_TO_CLOUD", "false").lower() != "true":
        return
    try:
        from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        provider = TracerProvider(
            resource=Resource.create({"service.name": "fitness-buddy-web"})
        )
        provider.add_span_processor(BatchSpanProcessor(CloudTraceSpanExporter()))
        trace.set_tracer_provider(provider)
    except Exception as exc:  # tracing must never break serving
        log_event(
            "tracing_setup_failed", severity=logging.WARNING, error=type(exc).__name__
        )


_tracer = trace.get_tracer("fitness_buddy.web")


def _attr(value: Any) -> bool | int | float | str:
    return value if isinstance(value, (bool, int, float, str)) else str(value)


def start_web_span(name: str, **attributes: Any) -> trace.Span:
    """Starts (without activating) a span; the caller must call ``span.end()``.

    Used around streaming generators, where activating a span across ``yield``
    points would detach the OpenTelemetry context in a different task.
    """
    span = _tracer.start_span(f"fitness_buddy.web.{name}")
    for key, value in attributes.items():
        if value is not None:
            span.set_attribute(f"fitness_buddy.{key}", _attr(value))
    return span


@contextmanager
def web_span(name: str, **attributes: Any) -> Iterator[trace.Span]:
    """Starts a span named ``fitness_buddy.web.<name>`` with non-PII attributes."""
    with _tracer.start_as_current_span(f"fitness_buddy.web.{name}") as span:
        for key, value in attributes.items():
            if value is not None:
                span.set_attribute(f"fitness_buddy.{key}", _attr(value))
        yield span
