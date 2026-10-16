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

import asyncio
import base64
import hashlib
import json
import logging
import secrets
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any, Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from fitness_core.models import utc_now
from fitness_core.repository import get_repository
from web.agent_client import AgentClient, AgentError, build_agent_client
from web.auth import (
    AllowlistDeniedError,
    CookieSigner,
    CurrentUser,
    clear_session,
    current_user,
    read_session,
    save_waitlist_entry,
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
from web.ratelimit import RateLimiter, build_rate_limiter

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
    lang: str | None = Field(default=None, description="UI language: en or zh.")


class SessionRequest(BaseModel):
    """Optional body for ``POST /api/session``."""

    new: bool = Field(default=False, description="Start a fresh conversation.")


TELEMETRY_EVENTS = frozenset(
    {
        "app_open",
        "tab_view",
        "quick_action",
        "onboarding_start",
        "onboarding_step",
        "onboarding_complete",
        "onboarding_skip",
        "suggestion_chip",
        "theme_change",
        "lang_change",
        "card_action",
        "feedback_open",
    }
)
DASHBOARD_TIMEOUT_S = 15.0
SESSION_TIMEOUT_S = 30.0


class FeedbackRequest(BaseModel):
    """A thumbs rating on a coach reply or general product feedback."""

    kind: Literal["message", "general"]
    rating: Literal["up", "down"] | None = None
    tags: list[Annotated[str, Field(max_length=40)]] = Field(
        default_factory=list, max_length=6
    )
    comment: str = Field(default="", max_length=2000)
    event_id: str | None = Field(default=None, max_length=200)
    page: (
        Literal["today", "coach", "progress", "plan", "onboarding", "landing"] | None
    ) = None
    lang: str | None = None


class TelemetryRequest(BaseModel):
    """A product-analytics UI event (no message text or PII)."""

    name: str = Field(max_length=40)
    props: dict[str, str | int | float | bool] = Field(
        default_factory=dict, max_length=10
    )


class DeleteAccountRequest(BaseModel):
    """Explicit confirmation for account deletion."""

    confirm: Literal["DELETE"]


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
    settings: WebSettings | None = None,
    agent_client: AgentClient | None = None,
    rate_limiter: RateLimiter | None = None,
) -> FastAPI:
    """Builds the FastAPI app.

    Args:
        settings: Web settings (defaults to the environment).
        agent_client: Agent backend (defaults to the one in ``AGENT_BACKEND``).
        rate_limiter: Per-user rate limiter (defaults to Firestore-backed).

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
    app.state.limiter = rate_limiter or build_rate_limiter()

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

    async def rate_limited(user: CurrentUser, scopes: list[str]) -> JSONResponse | None:
        """Returns a 429 response when the user is over a limit, else None."""
        decision = await app.state.limiter.hit(user.user_id, scopes)
        if decision.allowed:
            return None
        log_event(
            "rate_limited",
            severity=logging.WARNING,
            scope=decision.scope,
            user=_pseudonym(user.user_id),
        )
        return JSONResponse(
            {
                "detail": "Too many requests. Please slow down and try again shortly.",
                "code": "rate_limited",
                "scope": decision.scope,
                "retry_after": decision.retry_after,
            },
            status_code=429,
            headers={"Retry-After": str(decision.retry_after)},
        )

    def active_session_id(request: Request, user: CurrentUser) -> str:
        session = read_session(request)
        if session.get("sid") and session.get("sid_user") == user.user_id:
            return str(session["sid"])
        raise HTTPException(
            status_code=409,
            detail="No active conversation. Call POST /api/session first.",
        )

    # ---------------------------------------------------------------- pages
    index_html = (
        (STATIC_DIR / "index.html")
        .read_text(encoding="utf-8")
        .replace(ASSET_VERSION_PLACEHOLDER, ASSET_VERSION)
    )

    @app.get("/", include_in_schema=False)
    async def index() -> HTMLResponse:
        return HTMLResponse(index_html, headers={"Cache-Control": "no-cache"})

    privacy_html = STATIC_DIR / "privacy.html"
    privacy_page = (
        privacy_html.read_text(encoding="utf-8").replace(
            ASSET_VERSION_PLACEHOLDER, ASSET_VERSION
        )
        if privacy_html.exists()
        else "<!doctype html><title>Privacy</title><p>Privacy policy coming soon.</p>"
    )

    @app.get("/manifest.webmanifest", include_in_schema=False)
    async def manifest() -> FileResponse:
        return FileResponse(
            STATIC_DIR / "manifest.webmanifest",
            media_type="application/manifest+json",
            headers={"Cache-Control": "no-cache"},
        )

    # iOS and some browsers request these at the site root regardless of <link> tags.
    @app.get("/apple-touch-icon.png", include_in_schema=False)
    @app.get("/apple-touch-icon-precomposed.png", include_in_schema=False)
    async def apple_touch_icon() -> FileResponse:
        return FileResponse(
            STATIC_DIR / "img" / "app" / "apple-touch-icon.png", media_type="image/png"
        )

    @app.get("/favicon.ico", include_in_schema=False)
    async def favicon() -> FileResponse:
        return FileResponse(
            STATIC_DIR / "img" / "app" / "icon-192.png", media_type="image/png"
        )

    @app.get("/privacy", include_in_schema=False)
    async def privacy() -> HTMLResponse:
        return HTMLResponse(privacy_page, headers={"Cache-Control": "no-cache"})

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
        except AllowlistDeniedError as exc:
            try:
                await save_waitlist_entry(
                    get_repository(),
                    exc.email,
                    {
                        "email": exc.email,
                        "given_name": exc.given_name,
                        "lang": normalize_lang(body.lang),
                        "requested_at": utc_now().isoformat(),
                        "status": "pending",
                    },
                )
            except Exception as store_exc:
                log_event(
                    "waitlist_store_failed",
                    severity=logging.WARNING,
                    detail=str(store_exc)[:200],
                )
            log_event(
                "sign_in",
                severity=logging.INFO,
                outcome="waitlisted",
                status=exc.status_code,
                user=_pseudonym(exc.user_id) if exc.user_id else None,
            )
            return JSONResponse(
                {
                    "detail": exc.detail,
                    "code": "waitlisted",
                    "email": exc.email,
                },
                status_code=exc.status_code,
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

        async def choose() -> dict[str, Any]:
            chosen: dict[str, Any] | None = None
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
            return chosen or await client.create_session(user.user_id)

        with web_span("open_session", backend=settings.agent_backend):
            try:
                chosen = await asyncio.wait_for(choose(), SESSION_TIMEOUT_S)
            except (
                Exception
            ) as exc:  # surface a friendly error instead (incl. timeouts)
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
            try:
                session = await asyncio.wait_for(
                    client.get_session(user.user_id, session_id), SESSION_TIMEOUT_S
                )
            except TimeoutError as exc:
                raise HTTPException(
                    status_code=504, detail="Loading the conversation took too long."
                ) from exc
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
        if intent != "greeting":
            scopes = ["messages_per_minute", "messages_per_day"]
            if intent == "photo":
                scopes.append("photos_per_day")
            if limited := await rate_limited(user, scopes):
                return limited
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
        if limited := await rate_limited(user, ["messages_per_minute"]):
            return limited
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
                return await asyncio.wait_for(
                    build_dashboard(get_repository(), user.user_id, range_days=range),
                    DASHBOARD_TIMEOUT_S,
                )
            except TimeoutError as exc:
                log_event("dashboard_timeout", severity=logging.ERROR)
                raise HTTPException(
                    status_code=504, detail="Loading your progress took too long."
                ) from exc
            except Exception as exc:  # surface a friendly error instead
                log_event(
                    "dashboard_failed",
                    severity=logging.ERROR,
                    error=type(exc).__name__,
                    detail=str(exc)[:200],
                )
                raise HTTPException(
                    status_code=502, detail="Could not load your progress right now."
                ) from exc

    # ------------------------------------------------------------ feedback & analytics
    @app.post("/api/feedback", status_code=204)
    async def feedback(request: Request, body: FeedbackRequest, user: UserDep):
        if body.kind == "general" and not (body.comment.strip() or body.tags):
            raise HTTPException(
                status_code=422, detail="Add a comment or pick a category."
            )
        if limited := await rate_limited(user, ["feedback"]):
            return limited
        session = read_session(request)
        record = {
            "created_at": utc_now().isoformat(),
            "user": _pseudonym(user.user_id),
            "kind": body.kind,
            "rating": body.rating,
            "tags": body.tags,
            # Free text may contain health details: redact PII before storing.
            "comment": redact_text(body.comment.strip())
            if body.comment.strip()
            else "",
            "event_id": body.event_id,
            "session_id": session.get("sid")
            if session.get("sid_user") == user.user_id
            else None,
            "page": body.page,
            "lang": normalize_lang(body.lang),
            "app_version": ASSET_VERSION,
        }
        try:
            await asyncio.wait_for(
                get_repository().add_feedback(record), DASHBOARD_TIMEOUT_S
            )
        except Exception as exc:  # the log line below still captures the rating
            log_event(
                "feedback_store_failed",
                severity=logging.ERROR,
                error=type(exc).__name__,
            )
        log_event(
            "user_feedback",
            kind=body.kind,
            rating=body.rating,
            tags=body.tags,
            has_comment=bool(body.comment.strip()),
            page=body.page,
            lang=record["lang"],
            event_id=body.event_id,
            session_id=record["session_id"],
            user=record["user"],
        )
        return None

    @app.post("/api/telemetry", status_code=204)
    async def telemetry(body: TelemetryRequest, user: UserDep) -> None:
        """Product analytics for UI interactions; unknown event names are ignored."""
        if body.name not in TELEMETRY_EVENTS:
            return None
        props = {
            str(k)[:40]: (v[:60] if isinstance(v, str) else v)
            for k, v in body.props.items()
            if str(k).isidentifier()
        }
        log_event("ui_event", name=body.name, user=_pseudonym(user.user_id), **props)
        return None

    # ------------------------------------------------------------ account (privacy)
    @app.get("/api/account/export")
    async def export_account(user: UserDep, client: AgentDep) -> JSONResponse:
        """Self-service data export: stored data, conversations and coach memories."""
        data = await get_repository().export_user_data(user.user_id)
        conversations: list[dict[str, Any]] = []
        memories: list[dict[str, Any]] = []
        try:
            sessions = await asyncio.wait_for(
                client.list_sessions(user.user_id), SESSION_TIMEOUT_S
            )
            for meta in sorted(sessions, key=session_last_update, reverse=True)[:50]:
                session = await client.get_session(user.user_id, str(meta["id"]))
                if session:
                    history = build_history(session_events(session))
                    conversations.append(
                        {"session_id": meta["id"], "messages": history["messages"]}
                    )
            memories = await asyncio.wait_for(
                client.list_user_memories(user.user_id), SESSION_TIMEOUT_S
            )
        except Exception as exc:  # export what we have; note the gap
            log_event(
                "account_export_partial",
                severity=logging.WARNING,
                error=type(exc).__name__,
            )
            data["export_note"] = (
                "Conversations or coach memories could not be exported right now."
            )
        log_event("account_export", user=_pseudonym(user.user_id))
        payload = {
            "exported_at": utc_now().isoformat(),
            "account": {"email": user.email},
            "data": data,
            "conversations": conversations,
            "coach_memories": memories,
        }
        filename = f"fitness-buddy-export-{utc_now().date().isoformat()}.json"
        return JSONResponse(
            payload,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.post("/api/account/delete")
    async def delete_account(
        request: Request, body: DeleteAccountRequest, user: UserDep, client: AgentDep
    ) -> JSONResponse:
        """Deletes the user's stored data, conversations and coach memories."""
        result: dict[str, Any] = {"deleted": True}
        result["documents"] = await get_repository().delete_user_data(user.user_id)
        errors: list[str] = []
        try:
            sessions = await asyncio.wait_for(
                client.list_sessions(user.user_id), SESSION_TIMEOUT_S
            )
            for meta in sessions:
                await client.delete_session(user.user_id, str(meta["id"]))
            result["conversations"] = len(sessions)
        except Exception as exc:
            errors.append(f"conversations:{type(exc).__name__}")
        try:
            result["memories"] = await asyncio.wait_for(
                client.delete_user_memories(user.user_id), SESSION_TIMEOUT_S
            )
        except Exception as exc:
            errors.append(f"memories:{type(exc).__name__}")
        log_event(
            "account_deleted",
            severity=logging.WARNING if errors else logging.INFO,
            user=_pseudonym(user.user_id),
            errors=errors,
            **{k: v for k, v in result.items() if k != "deleted"},
        )
        if errors:
            result["incomplete"] = errors
        response = JSONResponse(result)
        clear_session(request, response)
        return response

    return app


app = create_app()
