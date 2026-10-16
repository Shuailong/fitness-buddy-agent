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

"""Human-in-the-loop gates on profile writes (NFR-O4)."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from app.schemas import FitnessProfileInput
from app.tools.profile_tools import save_fitness_profile
from fitness_core import repository as repo_module


class FakeToolContext:
    """Minimal stand-in for ADK's ToolContext used by the profile tools."""

    def __init__(self, confirmed: bool | None = None) -> None:
        self.user_id = "u-gate"
        self.session = SimpleNamespace(id="s1")
        self.tool_confirmation = (
            None if confirmed is None else SimpleNamespace(confirmed=confirmed)
        )
        self.actions = SimpleNamespace(skip_summarization=False)
        self.requested: list[dict[str, Any]] = []

    def request_confirmation(self, *, hint: str, payload: dict[str, Any]) -> None:
        self.requested.append({"hint": hint, "payload": payload})


@pytest.fixture
def memory_repo(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FITNESS_STORAGE_BACKEND", "memory")
    monkeypatch.delenv("FITNESS_EVAL_ISOLATION", raising=False)
    repo_module.get_repository.cache_clear()
    yield repo_module.get_repository()
    repo_module.get_repository.cache_clear()


def _answers(days: int) -> FitnessProfileInput:
    return FitnessProfileInput(
        goal="muscle_gain",
        sex="male",
        age=30,
        height_value=178,
        weight_value=75,
        training_days_per_week=days,
        minutes_per_session=45,
        equipment=["dumbbells"],
        timezone="UTC",
    )


def test_target_change_on_existing_profile_requires_confirmation(memory_repo) -> None:
    async def scenario() -> None:
        # Onboarding (no profile yet) saves directly.
        first = await save_fitness_profile(_answers(4), FakeToolContext())
        assert first["status"] == "saved"
        before = (await memory_repo.get_profile("u-gate")).targets.daily_calories_kcal

        # Fewer training days changes the target: pause for confirmation.
        ctx = FakeToolContext()
        pending = await save_fitness_profile(_answers(3), ctx)
        assert pending["status"] == "pending_confirmation"
        payload = ctx.requested[0]["payload"]
        assert payload["kind"] == "update_calorie_target"
        assert payload["details"]["current_kcal"] == before
        assert payload["details"]["new_kcal"] != before
        stored = await memory_repo.get_profile("u-gate")
        assert stored.training_days_per_week == 4  # nothing written yet

        # Rejected: still nothing written.
        rejected = await save_fitness_profile(
            _answers(3), FakeToolContext(confirmed=False)
        )
        assert rejected["status"] == "rejected_by_user"
        assert (await memory_repo.get_profile("u-gate")).training_days_per_week == 4

        # Confirmed: saved with the new target.
        done = await save_fitness_profile(_answers(3), FakeToolContext(confirmed=True))
        assert done["status"] == "saved"
        after = await memory_repo.get_profile("u-gate")
        assert after.training_days_per_week == 3
        assert after.targets.daily_calories_kcal == payload["details"]["new_kcal"]

        # Edits that keep the same target are not gated.
        same = await save_fitness_profile(_answers(3), FakeToolContext())
        assert same["status"] == "saved"

    asyncio.run(scenario())


def test_gemini_project_override(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.config import gemini, gemini_client_kwargs

    monkeypatch.delenv("GEMINI_PROJECT", raising=False)
    assert gemini_client_kwargs() is None
    assert gemini("gemini-test").client_kwargs is None

    monkeypatch.setenv("GEMINI_PROJECT", "other-project")
    expected = {"vertexai": True, "project": "other-project", "location": "global"}
    assert gemini_client_kwargs() == expected
    assert gemini("gemini-test").client_kwargs == expected
