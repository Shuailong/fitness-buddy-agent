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

"""Fitness Buddy web backend (Cloud Run): sign-in, chat over SSE, confirmations, dashboard.

Run locally::

    uv run uvicorn app.fast_api_app:app --port 8000          # the agent
    AGENT_BACKEND=local DEV_AUTH_BYPASS=true \\
        uv run uvicorn web.main:app --port 8080              # this app
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import secrets
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from fitness_core.repository import get_repository
from web.agent_client import AgentClient, AgentError, build_agent_client
from web.auth import (
    CookieSigner,
    CurrentUser,
    clear_session,
    current_user,
    read_session,
    verify_google_credential,
    write_session,
)
from web.config import (
    ALLOWED_IMAGE_TYPES,
    GREETING_TEXT,
    GREETING_TEXTS,
    MAX_IMAGE_BYTES,
    WebSettings,
    normalize_lang,
)
from web.dashboard import build_dashboard
from web.events import (
    CONFIRMATION_CALL,
    build_history,
    has_pending_confirmation,
    session_events,
    session_last_update,
    simplify_event,
)
from web.observability import (
    log_event,
    redact_text,
    setup_logging,
    setup_tracing,
    start_web_span,
    web_span,
)

load_dotenv(Path(__file__).parent / ".env")

STATIC_DIR = Path(__file__).parent / "static"
ASSET_VERSION_PLACEHOLDER = "__ASSET_VERSION__"


def _asset_version() -> str:
    """Content hash of the static files, appended to asset URLs (cache busting)."""
    digest = hashlib.sha256()
    for path in sorted(STATIC_DIR.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(STATIC_DIR).as_posix().encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


ASSET_VERSION = _asset_version()
MAX_TEXT_CHARS = 4000

_IMAGE_SIGNATURES: list[tuple[str, bytes, int]] = [
    ("image/jpeg", b"\xff\xd8\xff", 0),
    ("image/png", b"\x89PNG\r\n\x1a\n", 0),
    ("image/webp", b"WEBP", 8),
]

_CSP = "; ".join(
    [
        "default-src 'self'",
        "script-src 'self' https://accounts.google.com/gsi/client",
        "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
        "frame-src https://accounts.google.com/gsi/",
        "connect-src 'self' https://accounts.google.com/gsi/",
        "img-src 'self' data: blob: https://*.googleusercontent.com",
        "base-uri 'none'",
        "form-action 'self'",
    ]
)


class GoogleCredential(BaseModel):
    """ID token returned by Google Identity Services."""

    credential: str = Field(min_length=10, max_length=8192)


class SessionRequest(BaseModel):
    """Optional body for ``POST /api/session``."""

    new: bool = Field(default=False, description="Start a fresh conversation.")


class ConfirmRequest(BaseModel):
    """The user's decision on a Confirm / Reject card."""

    call_id: str = Field(min_length=1, max_length=200)
    confirmed: bool
    lang: str | None = Field(default=None, description="UI language: en or zh.")


def get_agent(request: Request) -> AgentClient:
    """FastAPI dependency: the app's agent client."""
    return request.app.state.agent


UserDep = Annotated[CurrentUser, Depends(current_user)]
AgentDep = Annotated[AgentClient, Depends(get_agent)]


def _pseudonym(user_id: str) -> str:
    """Stable, non-reversible user reference for logs (no raw IDs or e-mails)."""
    return hashlib.sha256(user_id.encode()).hexdigest()[:16]


def _sniff_image(data: bytes) -> str | None:
    for mime, signature, offset in _IMAGE_SIGNATURES:
        if data[offset : offset + len(signature)] == signature:
            return mime
    return None


def _sse(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def create_app(
    settings: WebSettings | None = None, agent_client: AgentClient | None = None
) -> FastAPI:
    """Builds the FastAPI app.

    Args:
        settings: Web settings (defaults to the environment).
        agent_client: Agent backend (defaults to the one in ``AGENT_BACKEND``).

    Returns:
        The configured app.

    Raises:
        RuntimeError: On Cloud Run without ``SESSION_SECRET``.
    """
    settings = settings or WebSettings.from_env()
    setup_logging()
    setup_tracing()
    secret = settings.session_secret
    if not secret:
        if settings.is_cloud_run:
            raise RuntimeError(
                "SESSION_SECRET must be set in production (inject it from Secret Manager)."
            )
        secret = secrets.token_urlsafe(32)
        log_event(
            "session_secret_ephemeral",
            severity=logging.WARNING,
            detail="SESSION_SECRET is unset; using a random per-process key (sessions reset on restart).",
        )
    if settings.is_cloud_run and not settings.google_client_id:
        log_event("google_client_id_missing", severity=logging.WARNING)

    app = FastAPI(
        title="Fitness Buddy Web", docs_url=None, redoc_url=None, openapi_url=None
    )
    app.state.settings = settings
    app.state.signer = CookieSigner(secret, settings.session_max_age_seconds)
    app.state.agent = agent_client or build_agent_client(settings)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault(
            "Referrer-Policy", "strict-origin-when-cross-origin"
        )
        response.headers.setdefault(
            "Cross-Origin-Opener-Policy", "same-origin-allow-popups"
        )
        response.headers.setdefault("Content-Security-Policy", _CSP)
        if request.url.path.startswith("/api/") or request.url.path.startswith(
            "/auth/"
        ):
            response.headers.setdefault("Cache-Control", "no-store")
        elif request.url.path.startswith("/static/"):
            # Always revalidate (cheap 304 via ETag) so a deploy never mixes a
            # new index.html with stale cached scripts or styles.
            response.headers.setdefault("Cache-Control", "no-cache")
        return response

    def active_session_id(request: Request, user: CurrentUser) -> str:
        session = read_session(request)
        if session.get("sid") and session.get("sid_user") == user.user_id:
            return str(session["sid"])
        raise HTTPException(
            status_code=409,
            detail="No active conversation. Call POST /api/session first.",
        )

    # ---------------------------------------------------------------- pages
    index_html = (STATIC_DIR / "index.html").read_text(encoding="utf-8").replace(
        ASSET_VERSION_PLACEHOLDER, ASSET_VERSION
    )

    @app.get("/", include_in_schema=False)
    async def index() -> HTMLResponse:
        return HTMLResponse(index_html, headers={"Cache-Control": "no-cache"})

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    # ----------------------------------------------------------------- auth
    @app.get("/api/config")
    async def config() -> dict[str, Any]:
        return {
            "google_client_id": settings.google_client_id,
            "dev_auth_bypass": settings.dev_auth_bypass,
            "greeting_text": GREETING_TEXT,
            "greeting_texts": GREETING_TEXTS,
            "max_image_bytes": MAX_IMAGE_BYTES,
        }

    @app.post("/auth/google")
    async def auth_google(body: GoogleCredential, request: Request) -> JSONResponse:
        try:
            user = await run_in_threadpool(
                verify_google_credential, body.credential, settings
            )
        except HTTPException as exc:
            log_event(
                "sign_in",
                severity=logging.WARNING,
                outcome="denied",
                status=exc.status_code,
            )
            raise
        log_event("sign_in", outcome="allowed", user=_pseudonym(user.user_id))
        response = JSONResponse({"email": user.email})
        write_session(
            request,
            response,
            {
                "sub": user.user_id,
                "email": user.email,
                "given_name": user.given_name,
                "picture": user.picture,
            },
        )
        return response

    @app.post("/auth/logout")
    async def auth_logout(request: Request) -> JSONResponse:
        response = JSONResponse({"ok": True})
        clear_session(request, response)
        return response

    @app.get("/api/me")
    async def me(user: UserDep) -> dict[str, Any]:
        return {
            "email": user.email,
            "given_name": user.given_name,
            "picture": user.picture,
            "dev_auth_bypass": settings.dev_auth_bypass,
        }

    # ------------------------------------------------------------- sessions
    def _usable(session: dict[str, Any] | None) -> bool:
        if not session:
            return False
        if settings.session_idle_hours <= 0 or has_pending_confirmation(session):
            return True
        return (
            time.time() - session_last_update(session)
            < settings.session_idle_hours * 3600
        )

    @app.post("/api/session")
    async def open_session(
        request: Request,
        user: UserDep,
        client: AgentDep,
        body: SessionRequest | None = None,
    ) -> JSONResponse:
        """Reuses the user's recent conversation or starts a new one.

        A conversation idle for more than ``SESSION_IDLE_HOURS`` is closed so
        the next visit starts fresh and the coach runs its check-ins (FR-8).
        """
        cookie = read_session(request)
        chosen: dict[str, Any] | None = None
        with web_span("open_session", backend=settings.agent_backend):
            try:
                if not (body and body.new):
                    if cookie.get("sid") and cookie.get("sid_user") == user.user_id:
                        candidate = await client.get_session(
                            user.user_id, str(cookie["sid"])
                        )
                        chosen = candidate if _usable(candidate) else None
                    if chosen is None:
                        sessions = await client.list_sessions(user.user_id)
                        if sessions:
                            latest = max(sessions, key=session_last_update)
                            candidate = await client.get_session(
                                user.user_id, str(latest["id"])
                            )
                            chosen = candidate if _usable(candidate) else None
                if chosen is None:
                    chosen = await client.create_session(user.user_id)
            except Exception as exc:  # surface a friendly error instead
                log_event(
                    "open_session_failed",
                    severity=logging.ERROR,
                    error=type(exc).__name__,
                )
                raise HTTPException(
                    status_code=502, detail="The coach is unavailable right now."
                ) from exc
        session_id = str(chosen["id"])
        is_new = not session_events(chosen)
        log_event(
            "open_session",
            user=_pseudonym(user.user_id),
            session_id=session_id,
            is_new=is_new,
        )
        response = JSONResponse({"session_id": session_id, "is_new": is_new})
        write_session(
            request,
            response,
            {
                **{k: v for k, v in cookie.items() if k != "iat"},
                "sid": session_id,
                "sid_user": user.user_id,
            },
        )
        return response

    @app.get("/api/history")
    async def history(
        request: Request,
        user: UserDep,
        client: AgentDep,
    ) -> dict[str, Any]:
        session_id = active_session_id(request, user)
        with web_span("history", backend=settings.agent_backend):
            session = await client.get_session(user.user_id, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="Conversation not found.")
        return {"session_id": session_id, **build_history(session_events(session))}

    # ------------------------------------------------------------ streaming
    async def stream_turn(
        user: CurrentUser,
        session_id: str,
        message: dict[str, Any],
        intent: str,
        preview: str,
        lang: str = "en",
    ) -> AsyncIterator[str]:
        """Runs one agent turn and yields simplified events as SSE frames."""
        client: AgentClient = app.state.agent
        started = time.monotonic()
        counts = {"text": 0, "activity": 0, "confirmation": 0, "error": 0}
        outcome = "ok"
        last_activity: str | None = None
        span = start_web_span(
            "agent_turn",
            backend=settings.agent_backend,
            intent=intent,
            session_id=session_id,
        )
        try:
            async for raw in client.stream_query(user.user_id, session_id, message):
                for event in simplify_event(raw, lang):
                    if event["type"] == "activity":
                        if event["label"] == last_activity:
                            continue
                        last_activity = event["label"]
                    else:
                        last_activity = None
                    counts[event["type"]] = counts.get(event["type"], 0) + 1
                    yield _sse(event)
        except AgentError as exc:
            outcome = "agent_error"
            counts["error"] += 1
            yield _sse({"type": "error", "message": str(exc)})
        except Exception as exc:  # never leak internals to the browser
            outcome = "error"
            counts["error"] += 1
            span.record_exception(exc)
            log_event(
                "agent_turn_exception", severity=logging.ERROR, error=type(exc).__name__
            )
            yield _sse(
                {
                    "type": "error",
                    "message": "The coach is unavailable right now. Please try again.",
                }
            )
        finally:
            if outcome == "ok" and counts["error"]:
                outcome = "agent_error"
            elif outcome == "ok" and counts["confirmation"]:
                outcome = "awaiting_confirmation"
            latency_ms = int((time.monotonic() - started) * 1000)
            span.set_attribute("fitness_buddy.outcome", outcome)
            span.set_attribute("fitness_buddy.latency_ms", latency_ms)
            span.end()
            log_event(
                "chat_turn",
                severity=logging.INFO
                if outcome in ("ok", "awaiting_confirmation")
                else logging.WARNING,
                intent=intent,
                request=preview,
                outcome=outcome,
                latency_ms=latency_ms,
                user=_pseudonym(user.user_id),
                session_id=session_id,
                **{f"{k}_events": v for k, v in counts.items()},
            )
        yield _sse({"type": "done"})

    def _sse_response(generator: AsyncIterator[str]) -> StreamingResponse:
        return StreamingResponse(
            generator,
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/chat")
    async def chat(
        request: Request,
        user: UserDep,
        text: Annotated[str, Form()] = "",
        image: Annotated[UploadFile | None, File()] = None,
        lang: Annotated[str | None, Form()] = None,
    ) -> StreamingResponse:
        session_id = active_session_id(request, user)
        text = text.strip()
        if len(text) > MAX_TEXT_CHARS:
            raise HTTPException(
                status_code=413,
                detail=f"Messages are limited to {MAX_TEXT_CHARS} characters.",
            )
        parts: list[dict[str, Any]] = []
        if text:
            parts.append({"text": text})
        if image is not None and (image.filename or image.size):
            data = await image.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise HTTPException(
                    status_code=413, detail="Photos are limited to 6 MB."
                )
            mime = _sniff_image(data)
            if mime not in ALLOWED_IMAGE_TYPES:
                raise HTTPException(
                    status_code=415, detail="Please upload a JPEG, PNG or WebP photo."
                )
            parts.append(
                {
                    "inlineData": {
                        "mimeType": mime,
                        "data": base64.b64encode(data).decode("ascii"),
                    }
                }
            )
        if not parts:
            raise HTTPException(status_code=400, detail="Send a message or a photo.")
        if text in GREETING_TEXTS.values():
            intent = "greeting"
        elif len(parts) > 1 or "inlineData" in parts[0]:
            intent = "photo"
        else:
            intent = "message"
        preview = redact_text(text) + (" [+photo]" if intent == "photo" else "")
        message = {"role": "user", "parts": parts}
        return _sse_response(
            stream_turn(
                user, session_id, message, intent, preview, normalize_lang(lang)
            )
        )

    @app.post("/api/confirm")
    async def confirm(
        body: ConfirmRequest,
        request: Request,
        user: UserDep,
        client: AgentDep,
    ) -> StreamingResponse:
        session_id = active_session_id(request, user)
        session = await client.get_session(user.user_id, session_id)
        pending = (
            build_history(session_events(session))["pending_confirmations"]
            if session
            else []
        )
        if body.call_id not in {p["call_id"] for p in pending}:
            raise HTTPException(
                status_code=409,
                detail="This request is no longer waiting for a decision.",
            )
        message = {
            "role": "user",
            "parts": [
                {
                    "functionResponse": {
                        "id": body.call_id,
                        "name": CONFIRMATION_CALL,
                        "response": {"confirmed": body.confirmed},
                    }
                }
            ],
        }
        intent = "confirm" if body.confirmed else "reject"
        return _sse_response(
            stream_turn(
                user, session_id, message, intent, intent, normalize_lang(body.lang)
            )
        )

    # ------------------------------------------------------------ dashboard
    @app.get("/api/dashboard")
    async def dashboard(user: UserDep, range: int | None = None) -> dict[str, Any]:
        with web_span("dashboard"):
            try:
                return await build_dashboard(
                    get_repository(), user.user_id, range_days=range
                )
            except Exception as exc:  # surface a friendly error instead
                log_event(
                    "dashboard_failed", severity=logging.ERROR, error=type(exc).__name__
                )
                raise HTTPException(
                    status_code=502, detail="Could not load your progress right now."
                ) from exc

    return app


app = create_app()
