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

# Fitness Buddy web app (Cloud Run). Build from the repository root:
#   docker build -f web/Dockerfile -t fitness-buddy-web .

FROM python:3.12-slim

# Install uv
COPY --from=ghcr.io/astral-sh/uv:0.8.13 /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /code

COPY ./pyproject.toml ./README.md ./uv.lock* ./

# Install third-party dependencies first (cached layer), then the project code.
RUN uv sync --frozen --no-dev --no-install-project

COPY ./fitness_core ./fitness_core
COPY ./web ./web
# The wheel lists every first-party package; the agent code itself is not used
# by the web app, so only an empty placeholder is needed for the build.
RUN mkdir -p app && touch app/__init__.py

RUN uv sync --frozen --no-dev && uv pip install --no-cache "edge-tts>=7.0.0"

# Run as an unprivileged user.
RUN useradd --create-home --uid 10001 appuser && chown -R appuser /code
USER appuser

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "uv run --no-sync uvicorn web.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]
