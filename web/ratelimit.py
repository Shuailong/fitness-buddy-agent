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

"""Per-user rate limits that protect model quota and cost.

Fixed-window counters keyed by ``(user, scope, window)``. In production the
counters live in Firestore (collection ``rate_limits``, expired by a TTL policy
on ``expire_at``) so limits hold across Cloud Run instances; tests and local
development use an in-process store.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol


@dataclass(frozen=True)
class Limit:
    """At most ``max_hits`` per ``window_seconds`` for one scope."""

    scope: str
    max_hits: int
    window_seconds: int


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def default_limits() -> dict[str, Limit]:
    """Limits sized for an invite-only beta (override with environment variables)."""
    return {
        "messages_per_minute": Limit(
            "messages_per_minute", _int_env("RATE_MESSAGES_PER_MINUTE", 10), 60
        ),
        "messages_per_day": Limit(
            "messages_per_day", _int_env("RATE_MESSAGES_PER_DAY", 300), 86400
        ),
        "photos_per_day": Limit(
            "photos_per_day", _int_env("RATE_PHOTOS_PER_DAY", 40), 86400
        ),
        "feedback": Limit("feedback", _int_env("RATE_FEEDBACK_PER_HOUR", 30), 3600),
    }


@dataclass(frozen=True)
class RateDecision:
    """Outcome of a rate-limit check."""

    allowed: bool
    scope: str = ""
    retry_after: int = 0


class CounterStore(Protocol):
    async def increment(self, key: str, expire_at: datetime) -> int: ...


class MemoryCounterStore:
    """Process-local counters (tests, local development)."""

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def increment(self, key: str, expire_at: datetime) -> int:
        async with self._lock:
            self._counts[key] = self._counts.get(key, 0) + 1
            return self._counts[key]


class FirestoreCounterStore:
    """Atomic Firestore counters shared by all web instances."""

    def __init__(self) -> None:
        from google.cloud import firestore

        self._firestore = firestore
        self._db = firestore.AsyncClient(
            project=os.environ.get("FITNESS_GCP_PROJECT")
            or os.environ.get("GOOGLE_CLOUD_PROJECT"),
            database=os.environ.get("FIRESTORE_DATABASE", "(default)"),
        )

    async def increment(self, key: str, expire_at: datetime) -> int:
        ref = self._db.collection("rate_limits").document(key)
        await ref.set(
            {"count": self._firestore.Increment(1), "expire_at": expire_at}, merge=True
        )
        snap = await ref.get()
        return int((snap.to_dict() or {}).get("count", 1))


class RateLimiter:
    """Checks and records hits against a set of limits."""

    def __init__(
        self, store: CounterStore, limits: dict[str, Limit] | None = None
    ) -> None:
        self._store = store
        self.limits = limits or default_limits()

    async def hit(
        self, user_id: str, scopes: list[str], now: float | None = None
    ) -> RateDecision:
        """Records one hit in every scope; denies if any scope is over its limit.

        Counters fail open: a storage error never blocks the user.
        """
        now = time.time() if now is None else now
        for scope in scopes:
            limit = self.limits[scope]
            window = int(now // limit.window_seconds)
            key = f"{user_id}:{scope}:{window}"
            expire_at = datetime.fromtimestamp(
                (window + 1) * limit.window_seconds, UTC
            ) + timedelta(hours=1)
            try:
                count = await self._store.increment(key, expire_at)
            except Exception:  # fail open on storage problems
                continue
            if count > limit.max_hits:
                retry_after = int((window + 1) * limit.window_seconds - now) + 1
                return RateDecision(False, scope, max(retry_after, 1))
        return RateDecision(True)


def build_rate_limiter() -> RateLimiter:
    """Firestore-backed in production, in-memory with the memory storage backend."""
    backend = os.environ.get("FITNESS_STORAGE_BACKEND", "firestore").lower()
    store: CounterStore = (
        MemoryCounterStore() if backend == "memory" else FirestoreCounterStore()
    )
    return RateLimiter(store)
