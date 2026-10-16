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

"""OpenTelemetry custom spans for domain operations (NFR-B3).

ADK already emits spans for agent invocations, LLM calls and tool calls. These
helpers add child spans around the deterministic domain logic and storage
calls, so a Cloud Trace waterfall shows the whole path from the user query to
the Firestore write.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from opentelemetry import trace

_tracer = trace.get_tracer("fitness_buddy")


@contextmanager
def domain_span(name: str, **attributes: Any) -> Iterator[trace.Span]:
    """Starts a child span named ``fitness_buddy.<name>`` with safe attributes.

    Args:
        name: Operation name, e.g. ``energy_targets``.
        **attributes: Non-PII attributes (counts, statuses, enum values).

    Yields:
        The active span, so callers can add result attributes.
    """
    with _tracer.start_as_current_span(f"fitness_buddy.{name}") as span:
        for key, value in attributes.items():
            if value is not None:
                span.set_attribute(
                    f"fitness_buddy.{key}",
                    value if isinstance(value, (bool, int, float, str)) else str(value),
                )
        yield span
