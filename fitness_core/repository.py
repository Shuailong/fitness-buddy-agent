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

"""Persistence for user fitness data (Firestore in production, in-memory for tests).

Firestore layout (all documents are scoped under the user's stable ID, which is
the Google account ``sub`` from web sign-in and the ADK ``user_id``)::

    users/{user_id}                          FitnessProfile
    users/{user_id}/training_plans/current   active TrainingPlan
    users/{user_id}/training_plans/{id}      archived TrainingPlans
    users/{user_id}/plan_adjustments/{date}  PlanAdjustment (one-off day changes)
    users/{user_id}/workout_logs/{id}        WorkoutSession
    users/{user_id}/meal_logs/{id}           MealEntry
    users/{user_id}/body_measurements/{id}   BodyMeasurement
    users/{user_id}/weekly_reviews/{id}      WeeklyReviewRecord
    users/{user_id}/meta/check_in_state      CheckInState

Date-range queries filter on the ``local_date`` string (ISO ``YYYY-MM-DD``), so
only single-field indexes are needed.
"""

from __future__ import annotations

import functools
import os
import uuid
from typing import Any, Literal, Protocol, TypeVar

from pydantic import BaseModel

from fitness_core.models import (
    BodyMeasurement,
    CheckInState,
    FitnessProfile,
    MealEntry,
    PlanAdjustment,
    TrainingPlan,
    UserMemory,
    WeeklyReviewRecord,
    WorkoutSession,
    utc_now,
)

EntryKind = Literal["workout", "meal", "measurement"]
_COLLECTION_BY_KIND: dict[str, str] = {
    "workout": "workout_logs",
    "meal": "meal_logs",
    "measurement": "body_measurements",
}
_MODEL_BY_COLLECTION: dict[str, type[BaseModel]] = {
    "workout_logs": WorkoutSession,
    "meal_logs": MealEntry,
    "body_measurements": BodyMeasurement,
    "weekly_reviews": WeeklyReviewRecord,
    "plan_adjustments": PlanAdjustment,
}
M = TypeVar("M", bound=BaseModel)


def new_entry_id() -> str:
    """Returns a new random entry ID."""
    return uuid.uuid4().hex[:20]


class FitnessRepository(Protocol):
    """Storage interface used by agent tools and the web dashboard."""

    async def get_profile(self, user_id: str) -> FitnessProfile | None: ...
    async def save_profile(self, profile: FitnessProfile) -> None: ...
    async def get_current_plan(self, user_id: str) -> TrainingPlan | None: ...
    async def save_current_plan(
        self, user_id: str, plan: TrainingPlan
    ) -> TrainingPlan: ...
    async def list_plan_adjustments(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[PlanAdjustment]: ...
    async def save_plan_adjustment(
        self, user_id: str, adjustment: PlanAdjustment
    ) -> None: ...
    async def delete_plan_adjustment(self, user_id: str, local_date: str) -> bool: ...
    async def add_entry(
        self, user_id: str, kind: EntryKind, entry: BaseModel
    ) -> None: ...
    async def list_workouts(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[WorkoutSession]: ...
    async def list_meals(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[MealEntry]: ...
    async def list_measurements(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[BodyMeasurement]: ...
    async def delete_entry(
        self, user_id: str, kind: EntryKind, entry_id: str
    ) -> bool: ...
    async def add_weekly_review(
        self, user_id: str, review: WeeklyReviewRecord
    ) -> None: ...
    async def latest_weekly_review(self, user_id: str) -> WeeklyReviewRecord | None: ...
    async def get_check_in_state(self, user_id: str) -> CheckInState: ...
    async def save_check_in_state(self, user_id: str, state: CheckInState) -> None: ...
    async def export_user_data(self, user_id: str) -> dict[str, Any]: ...
    async def delete_user_data(self, user_id: str) -> int: ...
    async def add_feedback(self, record: dict[str, Any]) -> None: ...
    async def list_memories(self, user_id: str) -> list[UserMemory]: ...
    async def save_memory(self, memory: UserMemory) -> None: ...
    async def delete_memory(self, user_id: str, memory_id: str) -> bool: ...


def _sort_key(entry: BaseModel) -> str:
    """Chronological key for any stored record (weekly reviews have no local_date)."""
    return str(
        getattr(entry, "local_date", None) or getattr(entry, "week_start", None) or ""
    )


def _in_range(local_date: str, start: str | None, end: str | None) -> bool:
    return (start is None or local_date >= start) and (end is None or local_date <= end)


class InMemoryFitnessRepository:
    """Process-local repository for unit tests and offline development."""

    def __init__(self) -> None:
        self._profiles: dict[str, FitnessProfile] = {}
        self._plans: dict[str, TrainingPlan] = {}
        self._archived_plans: dict[str, list[TrainingPlan]] = {}
        self._entries: dict[tuple[str, str], dict[str, BaseModel]] = {}
        self._check_ins: dict[str, CheckInState] = {}
        self._memories: dict[str, dict[str, UserMemory]] = {}
        self.feedback: list[dict[str, Any]] = []

    async def get_profile(self, user_id: str) -> FitnessProfile | None:
        return self._profiles.get(user_id)

    async def save_profile(self, profile: FitnessProfile) -> None:
        self._profiles[profile.user_id] = profile

    async def get_current_plan(self, user_id: str) -> TrainingPlan | None:
        return self._plans.get(user_id)

    async def save_current_plan(self, user_id: str, plan: TrainingPlan) -> TrainingPlan:
        if user_id in self._plans:
            self._archived_plans.setdefault(user_id, []).append(self._plans[user_id])
        stored = plan.model_copy(
            update={"plan_id": plan.plan_id or new_entry_id(), "created_at": utc_now()}
        )
        self._plans[user_id] = stored
        return stored

    def _bucket(self, user_id: str, collection: str) -> dict[str, BaseModel]:
        return self._entries.setdefault((user_id, collection), {})

    async def list_plan_adjustments(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[PlanAdjustment]:
        return self._list(user_id, "plan_adjustments", start, end)

    async def save_plan_adjustment(
        self, user_id: str, adjustment: PlanAdjustment
    ) -> None:
        self._bucket(user_id, "plan_adjustments")[adjustment.local_date] = adjustment

    async def delete_plan_adjustment(self, user_id: str, local_date: str) -> bool:
        return (
            self._bucket(user_id, "plan_adjustments").pop(local_date, None) is not None
        )

    async def add_entry(self, user_id: str, kind: EntryKind, entry: BaseModel) -> None:
        self._bucket(user_id, _COLLECTION_BY_KIND[kind])[entry.entry_id] = entry  # type: ignore[attr-defined]

    def _list(
        self, user_id: str, collection: str, start: str | None, end: str | None
    ) -> list:
        items = [
            e
            for e in self._bucket(user_id, collection).values()
            if _in_range(e.local_date, start, end)
        ]  # type: ignore[attr-defined]
        return sorted(items, key=lambda e: e.local_date)  # type: ignore[attr-defined]

    async def list_workouts(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[WorkoutSession]:
        return self._list(user_id, "workout_logs", start, end)

    async def list_meals(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[MealEntry]:
        return self._list(user_id, "meal_logs", start, end)

    async def list_measurements(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[BodyMeasurement]:
        return self._list(user_id, "body_measurements", start, end)

    async def delete_entry(self, user_id: str, kind: EntryKind, entry_id: str) -> bool:
        return (
            self._bucket(user_id, _COLLECTION_BY_KIND[kind]).pop(entry_id, None)
            is not None
        )

    async def add_weekly_review(self, user_id: str, review: WeeklyReviewRecord) -> None:
        self._bucket(user_id, "weekly_reviews")[review.entry_id] = review

    async def latest_weekly_review(self, user_id: str) -> WeeklyReviewRecord | None:
        reviews = list(self._bucket(user_id, "weekly_reviews").values())
        return max(reviews, key=lambda r: r.created_at, default=None)  # type: ignore[attr-defined]

    async def get_check_in_state(self, user_id: str) -> CheckInState:
        return self._check_ins.get(user_id, CheckInState())

    async def save_check_in_state(self, user_id: str, state: CheckInState) -> None:
        self._check_ins[user_id] = state

    async def export_user_data(self, user_id: str) -> dict[str, Any]:
        dump = lambda m: m.model_dump(mode="json")  # noqa: E731
        profile = self._profiles.get(user_id)
        plan = self._plans.get(user_id)
        data: dict[str, Any] = {
            "profile": dump(profile) if profile else None,
            "training_plans": ([dump(plan) | {"_id": "current"}] if plan else [])
            + [dump(p) for p in self._archived_plans.get(user_id, [])],
            "meta": [dump(self._check_ins[user_id]) | {"_id": "check_in_state"}]
            if user_id in self._check_ins
            else [],
        }
        for (uid, collection), bucket in self._entries.items():
            if uid == user_id:
                data[collection] = [dump(e) for e in bucket.values()]
        if self._memories.get(user_id):
            data["memories"] = [dump(m) for m in self._memories[user_id].values()]
        return data

    async def delete_user_data(self, user_id: str) -> int:
        deleted = int(self._profiles.pop(user_id, None) is not None)
        deleted += int(self._plans.pop(user_id, None) is not None)
        deleted += len(self._archived_plans.pop(user_id, []))
        deleted += int(self._check_ins.pop(user_id, None) is not None)
        deleted += len(self._memories.pop(user_id, {}))
        for key in [k for k in self._entries if k[0] == user_id]:
            deleted += len(self._entries.pop(key))
        return deleted

    async def add_feedback(self, record: dict[str, Any]) -> None:
        self.feedback.append(dict(record))

    async def list_memories(self, user_id: str) -> list[UserMemory]:
        return sorted(
            self._memories.get(user_id, {}).values(), key=lambda m: m.created_at
        )

    async def save_memory(self, memory: UserMemory) -> None:
        self._memories.setdefault(memory.user_id, {})[memory.memory_id] = memory

    async def delete_memory(self, user_id: str, memory_id: str) -> bool:
        return self._memories.get(user_id, {}).pop(memory_id, None) is not None


class FirestoreFitnessRepository:
    """Firestore-backed repository (Native mode, async client)."""

    def __init__(self, project: str | None = None, database: str | None = None) -> None:
        from google.cloud import firestore

        self._db = firestore.AsyncClient(
            project=project
            or os.environ.get("FITNESS_GCP_PROJECT")
            or os.environ.get("GOOGLE_CLOUD_PROJECT"),
            database=database or os.environ.get("FIRESTORE_DATABASE", "(default)"),
        )

    def _user(self, user_id: str):
        return self._db.collection("users").document(user_id)

    async def get_profile(self, user_id: str) -> FitnessProfile | None:
        snap = await self._user(user_id).get()
        return FitnessProfile.model_validate(snap.to_dict()) if snap.exists else None

    async def save_profile(self, profile: FitnessProfile) -> None:
        await self._user(profile.user_id).set(profile.model_dump(mode="json"))

    async def get_current_plan(self, user_id: str) -> TrainingPlan | None:
        snap = (
            await self._user(user_id)
            .collection("training_plans")
            .document("current")
            .get()
        )
        return TrainingPlan.model_validate(snap.to_dict()) if snap.exists else None

    async def save_current_plan(self, user_id: str, plan: TrainingPlan) -> TrainingPlan:
        plans = self._user(user_id).collection("training_plans")
        previous = await plans.document("current").get()
        if previous.exists:
            old = previous.to_dict()
            await plans.document(old.get("plan_id") or new_entry_id()).set(old)
        stored = plan.model_copy(
            update={"plan_id": plan.plan_id or new_entry_id(), "created_at": utc_now()}
        )
        await plans.document("current").set(stored.model_dump(mode="json"))
        return stored

    async def list_plan_adjustments(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[PlanAdjustment]:
        return await self._list(user_id, "plan_adjustments", start, end)

    async def save_plan_adjustment(
        self, user_id: str, adjustment: PlanAdjustment
    ) -> None:
        await (
            self._user(user_id)
            .collection("plan_adjustments")
            .document(adjustment.local_date)
            .set(adjustment.model_dump(mode="json"))
        )

    async def delete_plan_adjustment(self, user_id: str, local_date: str) -> bool:
        ref = self._user(user_id).collection("plan_adjustments").document(local_date)
        if not (await ref.get()).exists:
            return False
        await ref.delete()
        return True

    async def add_entry(self, user_id: str, kind: EntryKind, entry: BaseModel) -> None:
        collection = _COLLECTION_BY_KIND[kind]
        await (
            self._user(user_id)
            .collection(collection)
            .document(entry.entry_id)
            .set(  # type: ignore[attr-defined]
                entry.model_dump(mode="json")
            )
        )

    async def _list(
        self, user_id: str, collection: str, start: str | None, end: str | None
    ) -> list:
        query = self._user(user_id).collection(collection)
        if start:
            query = query.where("local_date", ">=", start)
        if end:
            query = query.where("local_date", "<=", end)
        model = _MODEL_BY_COLLECTION[collection]
        items = [model.model_validate(doc.to_dict()) async for doc in query.stream()]
        return sorted(items, key=_sort_key)

    async def list_workouts(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[WorkoutSession]:
        return await self._list(user_id, "workout_logs", start, end)

    async def list_meals(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[MealEntry]:
        return await self._list(user_id, "meal_logs", start, end)

    async def list_measurements(
        self, user_id: str, start: str | None = None, end: str | None = None
    ) -> list[BodyMeasurement]:
        return await self._list(user_id, "body_measurements", start, end)

    async def delete_entry(self, user_id: str, kind: EntryKind, entry_id: str) -> bool:
        ref = (
            self._user(user_id).collection(_COLLECTION_BY_KIND[kind]).document(entry_id)
        )
        if not (await ref.get()).exists:
            return False
        await ref.delete()
        return True

    async def add_weekly_review(self, user_id: str, review: WeeklyReviewRecord) -> None:
        await (
            self._user(user_id)
            .collection("weekly_reviews")
            .document(review.entry_id)
            .set(review.model_dump(mode="json"))
        )

    async def latest_weekly_review(self, user_id: str) -> WeeklyReviewRecord | None:
        reviews = await self._list(user_id, "weekly_reviews", None, None)
        return max(reviews, key=lambda r: r.created_at, default=None)

    async def get_check_in_state(self, user_id: str) -> CheckInState:
        snap = (
            await self._user(user_id)
            .collection("meta")
            .document("check_in_state")
            .get()
        )
        return (
            CheckInState.model_validate(snap.to_dict())
            if snap.exists
            else CheckInState()
        )

    async def save_check_in_state(self, user_id: str, state: CheckInState) -> None:
        await (
            self._user(user_id)
            .collection("meta")
            .document("check_in_state")
            .set(state.model_dump(mode="json"))
        )

    async def export_user_data(self, user_id: str) -> dict[str, Any]:
        """All of a user's documents: the profile plus every subcollection."""
        user = self._user(user_id)
        snap = await user.get()
        data: dict[str, Any] = {"profile": snap.to_dict() if snap.exists else None}
        async for collection in user.collections():
            data[collection.id] = [
                {"_id": doc.id, **(doc.to_dict() or {})}
                async for doc in collection.stream()
            ]
        return data

    async def delete_user_data(self, user_id: str) -> int:
        """Deletes the user document and all subcollections; returns docs deleted."""
        return int(await self._db.recursive_delete(self._user(user_id)))

    async def add_feedback(self, record: dict[str, Any]) -> None:
        await self._db.collection("feedback").document(new_entry_id()).set(record)

    def _memories(self, user_id: str):
        return self._user(user_id).collection("memories")

    async def list_memories(self, user_id: str) -> list[UserMemory]:
        items = [
            UserMemory.model_validate(doc.to_dict())
            async for doc in self._memories(user_id).stream()
        ]
        return sorted(items, key=lambda m: m.created_at)

    async def save_memory(self, memory: UserMemory) -> None:
        await (
            self._memories(memory.user_id)
            .document(memory.memory_id)
            .set(memory.model_dump(mode="json"))
        )

    async def delete_memory(self, user_id: str, memory_id: str) -> bool:
        ref = self._memories(user_id).document(memory_id)
        if not (await ref.get()).exists:
            return False
        await ref.delete()
        return True


@functools.cache
def get_repository() -> FitnessRepository:
    """Returns the process-wide repository selected by ``FITNESS_STORAGE_BACKEND``.

    ``firestore`` (default when a project is configured) or ``memory``.
    """
    backend = os.environ.get("FITNESS_STORAGE_BACKEND", "firestore").lower()
    if backend == "memory":
        return InMemoryFitnessRepository()
    return FirestoreFitnessRepository()
