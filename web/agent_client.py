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

"""Clients that talk to the deployed (or local) ADK agent.

Two interchangeable backends, selected by ``AGENT_BACKEND``:

* ``local``: the ADK API server started with
  ``uv run uvicorn app.fast_api_app:app --port 8000`` (``/apps/...`` session
  routes and ``/run_sse``).
* ``agent_runtime``: an agent deployed to Agent Runtime, called through the
  ``vertexai`` SDK (``async_stream_query`` = ``:streamQuery``).

Both return raw ADK session / event dicts. Keys may be camelCase (ADK API
server) or snake_case (Agent Runtime); :mod:`web.events` accepts both.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, Protocol

import httpx

from web.config import WebSettings


class AgentError(RuntimeError):
    """The agent backend failed; the message is safe to show to the user."""


class AgentClient(Protocol):
    """Backend-neutral interface used by the web endpoints."""

    async def create_session(self, user_id: str) -> dict[str, Any]: ...
    async def list_sessions(self, user_id: str) -> list[dict[str, Any]]: ...
    async def get_session(
        self, user_id: str, session_id: str
    ) -> dict[str, Any] | None: ...
    def stream_query(
        self, user_id: str, session_id: str, message: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]: ...
    async def delete_session(self, user_id: str, session_id: str) -> None: ...
    async def delete_user_memories(self, user_id: str) -> int: ...
    async def list_user_memories(self, user_id: str) -> list[dict[str, Any]]: ...


def _to_dict(obj: Any) -> Any:
    """Converts SDK / pydantic objects to plain JSON-compatible dicts."""
    if obj is None or isinstance(obj, (dict, list, str, int, float, bool)):
        return obj
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json", exclude_none=True)
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    return dict(obj)


class LocalAdkClient:
    """Talks to a local ADK API server over HTTP."""

    def __init__(
        self, base_url: str, app_name: str = "app", timeout: float = 300.0
    ) -> None:
        self._base = base_url.rstrip("/")
        self._app = app_name
        self._timeout = httpx.Timeout(timeout, connect=10.0)

    def _sessions_url(self, user_id: str) -> str:
        return f"{self._base}/apps/{self._app}/users/{user_id}/sessions"

    async def create_session(self, user_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(self._sessions_url(user_id), json={})
            resp.raise_for_status()
            return resp.json()

    async def list_sessions(self, user_id: str) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(self._sessions_url(user_id))
            resp.raise_for_status()
            return list(resp.json())

    async def get_session(self, user_id: str, session_id: str) -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(f"{self._sessions_url(user_id)}/{session_id}")
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json()

    async def stream_query(
        self, user_id: str, session_id: str, message: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        body = {
            "appName": self._app,
            "userId": user_id,
            "sessionId": session_id,
            "newMessage": message,
            "streaming": False,
        }
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            async with client.stream(
                "POST", f"{self._base}/run_sse", json=body
            ) as resp:
                if resp.status_code >= 400:
                    await resp.aread()
                    raise AgentError(f"Agent server returned HTTP {resp.status_code}.")
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:") :].strip()
                    if not data:
                        continue
                    event = json.loads(data)
                    if (
                        isinstance(event, dict)
                        and "error" in event
                        and "content" not in event
                    ):
                        raise AgentError("The coach hit an error. Please try again.")
                    yield event

    async def delete_session(self, user_id: str, session_id: str) -> None:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.delete(f"{self._sessions_url(user_id)}/{session_id}")
            if resp.status_code not in (200, 204, 404):
                resp.raise_for_status()

    async def delete_user_memories(self, user_id: str) -> int:
        # The local ADK server keeps memories in process; nothing durable to delete.
        return 0

    async def list_user_memories(self, user_id: str) -> list[dict[str, Any]]:
        return []


class AgentRuntimeClient:
    """Talks to an agent deployed on Agent Runtime through the ``vertexai`` SDK."""

    def __init__(self, project: str, location: str, resource_name: str) -> None:
        if not resource_name:
            raise ValueError(
                "AGENT_RUNTIME_RESOURCE is required when AGENT_BACKEND=agent_runtime."
            )
        self._project = project
        self._location = location
        self._resource = resource_name
        self._agent: Any = None
        self._lock = asyncio.Lock()

    async def _remote(self) -> Any:
        if self._agent is None:
            async with self._lock:
                if self._agent is None:

                    def _connect() -> Any:
                        import vertexai

                        client = vertexai.Client(
                            project=self._project or None, location=self._location
                        )
                        return client.agent_engines.get(name=self._resource)

                    self._agent = await asyncio.to_thread(_connect)
        return self._agent

    async def create_session(self, user_id: str) -> dict[str, Any]:
        agent = await self._remote()
        return _to_dict(await agent.async_create_session(user_id=user_id))

    async def list_sessions(self, user_id: str) -> list[dict[str, Any]]:
        agent = await self._remote()
        result = _to_dict(await agent.async_list_sessions(user_id=user_id))
        if isinstance(result, dict):
            result = result.get("sessions", [])
        return [_to_dict(s) for s in result or []]

    async def get_session(self, user_id: str, session_id: str) -> dict[str, Any] | None:
        agent = await self._remote()
        try:
            return _to_dict(
                await agent.async_get_session(user_id=user_id, session_id=session_id)
            )
        except Exception:  # the SDK raises generic errors for 'not found'
            return None

    async def stream_query(
        self, user_id: str, session_id: str, message: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        agent = await self._remote()
        async for event in agent.async_stream_query(
            user_id=user_id, session_id=session_id, message=message
        ):
            yield _to_dict(event)

    async def delete_session(self, user_id: str, session_id: str) -> None:
        agent = await self._remote()
        await agent.async_delete_session(user_id=user_id, session_id=session_id)

    def _memories_api(self) -> tuple[Any, str]:
        import google.auth
        from google.auth.transport.requests import AuthorizedSession

        credentials, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        host = f"https://{self._location}-aiplatform.googleapis.com/v1beta1"
        return AuthorizedSession(credentials), host

    def _iter_user_memories(self, http: Any, host: str, user_id: str) -> list[dict[str, Any]]:
        """All Memory Bank memories whose scope is exactly this user."""
        found: list[dict[str, Any]] = []
        page_token, use_filter = "", True
        while True:
            params: dict[str, Any] = {"pageSize": 100}
            if use_filter:
                params["filter"] = f'scope.user_id="{user_id}"'
            if page_token:
                params["pageToken"] = page_token
            resp = http.get(f"{host}/{self._resource}/memories", params=params, timeout=30)
            if resp.status_code == 400 and use_filter:
                # Filter expression not supported: list everything, check scope below.
                use_filter, page_token = False, ""
                continue
            resp.raise_for_status()
            body = resp.json()
            # Never trust the filter alone: check the scope explicitly.
            found += [
                m for m in body.get("memories", [])
                if (m.get("scope") or {}).get("user_id") == user_id
            ]
            page_token = body.get("nextPageToken", "")
            if not page_token:
                return found

    async def list_user_memories(self, user_id: str) -> list[dict[str, Any]]:
        def _list() -> list[dict[str, Any]]:
            http, host = self._memories_api()
            return [
                {k: m.get(k) for k in ("fact", "createTime", "updateTime")}
                for m in self._iter_user_memories(http, host, user_id)
            ]

        return await asyncio.to_thread(_list)

    async def delete_user_memories(self, user_id: str) -> int:
        """Deletes every Memory Bank memory scoped to this user (REST API)."""

        def _delete_all() -> int:
            http, host = self._memories_api()
            memories = self._iter_user_memories(http, host, user_id)
            for memory in memories:
                http.delete(f"{host}/{memory['name']}", timeout=30).raise_for_status()
            return len(memories)

        return await asyncio.to_thread(_delete_all)


def build_agent_client(settings: WebSettings) -> AgentClient:
    """Creates the agent client selected by ``AGENT_BACKEND``."""
    if settings.agent_backend == "agent_runtime":
        return AgentRuntimeClient(
            project=settings.agent_runtime_project,
            location=settings.agent_runtime_location,
            resource_name=settings.agent_runtime_resource,
        )
    if settings.agent_backend == "local":
        return LocalAdkClient(
            settings.local_agent_url,
            settings.agent_app_name,
            settings.agent_timeout_seconds,
        )
    raise ValueError(
        f"Unknown AGENT_BACKEND '{settings.agent_backend}' (use 'local' or 'agent_runtime')."
    )
