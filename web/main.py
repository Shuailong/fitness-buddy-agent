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
import contextlib
import hashlib
import hmac
import json
import logging
import secrets
import time
from collections.abc import AsyncIterator
from datetime import date
from pathlib import Path
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    Response,
    StreamingResponse,
)
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from fitness_core.memories import CATEGORIES as MEMORY_CATEGORIES
from fitness_core.memories import MAX_MEMORIES, remember
from fitness_core.models import utc_now
from fitness_core.repository import get_repository
from web.admin import (
    build_admin_overview,
    estimate_turn_tokens_and_cost,
    extract_client_geo,
    get_user_privacy_pref,
    purge_user_telemetry,
    record_ops_event,
    set_user_privacy_pref,
    touch_user_presence,
    update_access_entry,
)
from web.agent_client import AgentClient, AgentError, build_agent_client
from web.auth import (
    AllowlistDeniedError,
    CookieSigner,
    CurrentUser,
    clear_session,
    current_user,
    get_user_role,
    get_waitlist_entry,
    is_email_allowed,
    read_session,
    save_waitlist_entry,
    verify_google_token_claims,
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
from web.dashboard import (
    build_dashboard,
    build_workout_history,
    get_meal_photo,
    get_pending_meal_photo,
    save_meal_photo,
    save_pending_meal_photo,
)
from web.demo import (
    client_ip_key,
    expired_demo_ids,
    forget_demo,
    new_demo_identity,
    register_demo,
    seed_demo_account,
)
from web.events import (
    CONFIRMATION_CALL,
    DEFAULT_TIMEZONE,
    build_history,
    conversation_day,
    extract_meal_photos_from_events,
    has_pending_confirmation,
    session_events,
    session_last_update,
    session_started_at,
    simplify_event,
    ui_language_part,
)
from web.form_coach import (
    analyze_exercise_form,
    build_persona_prefix,
    synthesize_coach_speech,
)
from web.messages import localize
from web.observability import (
    log_event,
    redact_text,
    setup_logging,
    setup_tracing,
    start_web_span,
    web_span,
)
from web.push import (
    PushConfig,
    delete_subscription,
    delete_user_subscriptions,
    get_subscription,
    list_subscriptions,
    save_subscription,
)
from web.push import dispatch as dispatch_push
from web.push import message as push_message
from web.push import send as send_push
from web.ratelimit import RateLimiter, build_rate_limiter
from web.user_prefs import forget_user_prefs, get_user_prefs, set_user_prefs
from web.voice import MAX_AUDIO_BYTES, VOICE_MARKER, sniff_audio, transcribe_audio

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


def precache_urls() -> list[str]:
    """The offline app shell: the page, its versioned assets and every JS module."""
    v = ASSET_VERSION
    urls = [
        "/",
        "/changelog",
        "/manifest.webmanifest",
        f"/static/app.js?v={v}",
        f"/static/styles.css?v={v}",
        f"/static/js/theme-boot.js?v={v}",
        "/static/icons.svg",
        "/static/img/app/icon-192.png",
        "/static/img/app/apple-touch-icon.png",
    ]
    urls += [
        f"/static/fonts/{p.name}"
        for p in sorted((STATIC_DIR / "fonts").glob("*.woff2"))
    ]
    # Modules are imported without ?v= (the cache itself is per deploy).
    urls += [
        f"/static/js/{p.name}"
        for p in sorted((STATIC_DIR / "js").glob("*.js"))
        if p.name not in ("install.js", "admin.js")
    ]
    return urls


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
        "connect-src 'self' ws: wss: https://accounts.google.com/gsi/",
        "img-src 'self' data: blob: https://*.googleusercontent.com",
        "media-src 'self' data: blob: mediastream:",
        "base-uri 'none'",
        "form-action 'self'",
    ]
)


class TtsRequest(BaseModel):
    """Request payload for synthesizing natural neural coach speech."""

    text: str = Field(min_length=1, max_length=2500)
    persona: str = Field(default="iron_leo", max_length=40)
    lang: str | None = Field(default="zh", max_length=12)


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=10, max_length=200)
    auth: str = Field(min_length=8, max_length=100)


class PushSubscription(BaseModel):
    endpoint: str = Field(min_length=10, max_length=1000, pattern=r"^https://")
    keys: PushKeys


class PushSubscribeRequest(BaseModel):
    """A browser push subscription plus reminder preferences."""

    subscription: PushSubscription
    lang: str | None = None
    timezone: str | None = Field(default=None, max_length=64)
    prefs: dict[Literal["training", "meals"], bool] = Field(default_factory=dict)


class PushEndpointRequest(BaseModel):
    endpoint: str = Field(min_length=10, max_length=1000)
    prefs: dict[Literal["training", "meals"], bool] | None = None


class DemoStartRequest(BaseModel):
    """Starts a no-sign-in demo account."""

    lang: str | None = Field(default=None, description="UI language: en or zh.")
    timezone: str | None = Field(default=None, max_length=64)


class GoogleCredential(BaseModel):
    """ID token returned by Google Identity Services."""

    credential: str = Field(min_length=10, max_length=8192)
    lang: str | None = Field(default=None, description="UI language: en or zh.")


class SessionRequest(BaseModel):
    """Optional body for ``POST /api/session``."""

    new: bool = Field(default=False, description="Start a fresh conversation.")
    include_history: bool = Field(
        default=False,
        description="When reusing a session, include rendered history in the same response.",
    )


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
        "tip_interact",
        "exercise_guide",
        "form_check",
        "persona_change",
        "history_older",
        "voice_message",
        "install_banner",
        "new_chat",
        "demo",
        "viewport",
        "coach_fab",
        "reminders",
    }
)
DASHBOARD_TIMEOUT_S = 15.0
SESSION_TIMEOUT_S = 30.0
# How long a new message waits for a reply still running in the background.
INFLIGHT_WAIT_S = 180.0
# A conversation paused on a Confirm / Reject card survives the daily rollover
# only for this long; older cards are stale.
PENDING_CONFIRMATION_KEEP_S = 6 * 3600

_TURN_LABELS = {
    "busy": {
        "en": "Still working on your previous message - this one is next…",
        "zh": "上一条消息还在分析中，完成后马上回复这条…",  # noqa: RUF001
    },
    "declined": {
        "en": "Cancelled an unanswered change request",
        "zh": "已取消之前未确认的变更",
    },
    "no_reply": {
        "en": "Your coach didn't reply this time. Please send it again.",
        "zh": "教练这次没有回复，请再发一次。",  # noqa: RUF001
    },
}


def _label(key: str, lang: str) -> str:
    """Localized status text for the chat stream."""
    labels = _TURN_LABELS[key]
    return labels.get(lang, labels["en"])


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
        Literal[
            "today",
            "coach",
            "progress",
            "plan",
            "settings",
            "onboarding",
            "landing",
            "admin",
        ]
        | None
    ) = None
    lang: str | None = None


class TelemetryRequest(BaseModel):
    """A product-analytics UI event (no message text or PII)."""

    name: str = Field(max_length=40)
    props: dict[str, str | int | float | bool] = Field(
        default_factory=dict, max_length=20
    )


class DeleteAccountRequest(BaseModel):
    """Explicit confirmation for account deletion."""

    confirm: Literal["DELETE"]


class PreferencesRequest(BaseModel):
    """Cross-device app preferences (currently the selected coach persona)."""

    coach_persona: str | None = Field(default=None, max_length=40)


class MemoryRequest(BaseModel):
    """A Coach Memory entry added or edited by the user in Settings."""

    text: str = Field(min_length=1, max_length=240)
    category: str = Field(default="other", max_length=20)
    replaces_memory_id: str | None = Field(default=None, max_length=40)


class PrivacySettingsRequest(BaseModel):
    """PDPA user consent toggle for optional usage & diagnostics data sharing."""

    share_usage_data: bool


class ConfirmRequest(BaseModel):
    """The user's decision on a Confirm / Reject card."""

    call_id: str = Field(min_length=1, max_length=200)
    confirmed: bool
    lang: str | None = Field(default=None, description="UI language: en or zh.")


class AdminAccessRequest(BaseModel):
    """Create or update a waitlist/allowlist entry and user role."""

    email: str = Field(min_length=3, max_length=160)
    status: Literal["pending", "approved", "revoked"] = "approved"
    role: Literal["member", "admin"] = "member"
    given_name: str = Field(default="", max_length=60)
    note: str = Field(default="", max_length=200)


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


# While the coach works (a photo analysis can take a minute or more when the
# model is slow) nothing else is sent. Mobile networks and proxies drop idle
# connections after ~30 s, so send an SSE comment as a keep-alive.
SSE_HEARTBEAT_S = 10.0
SSE_HEARTBEAT = ": keep-alive\n\n"


async def with_heartbeat(
    frames: AsyncIterator[str], interval: float = SSE_HEARTBEAT_S
) -> AsyncIterator[str]:
    """Re-yields ``frames``, adding a keep-alive comment after ``interval`` idle."""
    it = frames.__aiter__()
    pending: asyncio.Task[str] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(it.__anext__())
            done, _ = await asyncio.wait({pending}, timeout=interval)
            if not done:
                yield SSE_HEARTBEAT
                continue
            try:
                frame = pending.result()
            except StopAsyncIteration:
                return
            finally:
                pending = None
            yield frame
    finally:
        if pending is not None:
            pending.cancel()
        aclose = getattr(it, "aclose", None)
        if aclose is not None:
            with contextlib.suppress(Exception):
                await aclose()


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
    app.state.push = PushConfig.from_env()

    @app.exception_handler(HTTPException)
    async def localized_http_error(
        request: Request, exc: HTTPException
    ) -> JSONResponse:
        """API errors in the UI language (X-UI-Lang header) - no English in a Chinese UI."""
        detail = exc.detail
        if isinstance(detail, str):
            detail = localize(detail, request.headers.get("x-ui-lang"))
        return JSONResponse(
            {"detail": detail}, status_code=exc.status_code, headers=exc.headers
        )

    app.add_middleware(GZipMiddleware, minimum_size=500)

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

    _DEMO_SCOPES = {
        "messages_per_day": "demo_messages_per_day",
        "photos_per_day": "demo_photos_per_day",
        "voice_per_day": "demo_voice_per_day",
    }

    async def rate_limited(user: CurrentUser, scopes: list[str]) -> JSONResponse | None:
        """Returns a 429 response when the user is over a limit, else None.

        Demo accounts use their own small daily quotas, and all demo messages
        together share a global daily cap.
        """
        if user.is_demo:
            scopes = [_DEMO_SCOPES.get(s, s) for s in scopes]
            if "demo_messages_per_day" in scopes:
                total = await app.state.limiter.hit("demo-all", ["demo_messages_total"])
                if not total.allowed:
                    return JSONResponse(
                        {
                            "detail": "The demo is busy right now. Sign in to keep chatting.",
                            "code": "rate_limited",
                            "scope": "demo_messages_total",
                            "retry_after": total.retry_after,
                        },
                        status_code=429,
                        headers={"Retry-After": str(total.retry_after)},
                    )
        decision = await app.state.limiter.hit(user.user_id, scopes)
        if decision.allowed:
            return None
        log_event(
            "rate_limited",
            severity=logging.WARNING,
            scope=decision.scope,
            user=_pseudonym(user.user_id),
        )
        await record_ops_event(
            get_repository(),
            "rate_limit",
            user_id=user.user_id,
            email=user.email,
            scope=decision.scope,
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

    install_html = STATIC_DIR / "install.html"
    install_page = (
        install_html.read_text(encoding="utf-8").replace(
            ASSET_VERSION_PLACEHOLDER, ASSET_VERSION
        )
        if install_html.exists()
        else "<!doctype html><title>Install</title><p>Coming soon.</p>"
    )

    changelog_page = (
        (STATIC_DIR / "changelog.html")
        .read_text(encoding="utf-8")
        .replace(ASSET_VERSION_PLACEHOLDER, ASSET_VERSION)
    )

    @app.get("/changelog", include_in_schema=False)
    async def changelog() -> HTMLResponse:
        """What's new: user-facing release notes (data in js/changelog-data.js)."""
        return HTMLResponse(changelog_page, headers={"Cache-Control": "no-cache"})

    @app.get("/install", include_in_schema=False)
    async def install() -> HTMLResponse:
        """Step-by-step guide to add the app to a phone's home screen."""
        return HTMLResponse(install_page, headers={"Cache-Control": "no-cache"})

    sw_source = (
        (STATIC_DIR / "sw.js")
        .read_text(encoding="utf-8")
        .replace(ASSET_VERSION_PLACEHOLDER, ASSET_VERSION)
        .replace("__PRECACHE__", json.dumps(precache_urls()))
    )

    @app.get("/sw.js", include_in_schema=False)
    async def service_worker() -> Response:
        """Root-scoped service worker: installability + offline app shell.

        The deploy's content hash is baked in, so every deploy installs a new
        worker that precaches the new shell and drops the old cache.
        """
        return Response(
            sw_source,
            media_type="text/javascript",
            headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
        )

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
            "demo_enabled": settings.demo_enabled,
        }

    async def purge_user_everywhere(user_id: str) -> dict[str, Any]:
        """Deletes a user's documents, conversations and coach memories."""
        client: AgentClient = app.state.agent
        repo = get_repository()
        result: dict[str, Any] = {"deleted": True}
        result["documents"] = await repo.delete_user_data(user_id)
        forget_user_prefs(repo, user_id)
        result["telemetry_purged"] = await purge_user_telemetry(repo, user_id)
        result["push_subscriptions"] = await delete_user_subscriptions(repo, user_id)
        errors: list[str] = []
        try:
            sessions = await asyncio.wait_for(
                client.list_sessions(user_id), SESSION_TIMEOUT_S
            )
            for meta in sessions:
                await client.delete_session(user_id, str(meta["id"]))
            result["conversations"] = len(sessions)
        except Exception as exc:
            errors.append(f"conversations:{type(exc).__name__}")
        try:
            result["memories"] = await asyncio.wait_for(
                client.delete_user_memories(user_id), SESSION_TIMEOUT_S
            )
        except Exception as exc:
            errors.append(f"memories:{type(exc).__name__}")
        if errors:
            result["incomplete"] = errors
        return result

    async def purge_expired_demos() -> None:
        """Sweeps demo accounts past their lifetime (runs after new demo starts)."""
        repo = get_repository()
        try:
            for user_id in await expired_demo_ids(repo):
                await purge_user_everywhere(user_id)
                await forget_demo(repo, user_id)
                log_event("demo_purged", user=_pseudonym(user_id))
        except Exception as exc:
            log_event(
                "demo_purge_failed", severity=logging.WARNING, error=type(exc).__name__
            )

    @app.post("/auth/demo")
    async def auth_demo(
        request: Request,
        background: BackgroundTasks,
        body: DemoStartRequest | None = None,
    ) -> JSONResponse:
        """Starts a throwaway demo account: no sign-in, small quotas, 24 h."""
        if not settings.demo_enabled:
            raise HTTPException(status_code=404, detail="Demo mode is off.")
        body = body or DemoStartRequest()
        lang = normalize_lang(body.lang)
        limiter = app.state.limiter
        for key, scope in (
            (client_ip_key(request), "demo_starts_per_ip"),
            ("demo-all", "demo_starts_total"),
        ):
            decision = await limiter.hit(key, [scope])
            if not decision.allowed:
                log_event("demo_start_limited", severity=logging.WARNING, scope=scope)
                return JSONResponse(
                    {
                        "detail": "Demo is busy right now. Please sign in or try again later.",
                        "code": "demo_unavailable",
                        "scope": scope,
                        "retry_after": decision.retry_after,
                    },
                    status_code=429,
                    headers={"Retry-After": str(decision.retry_after)},
                )
        identity = new_demo_identity(lang)
        repo = get_repository()
        timezone = (body.timezone or "").strip()
        try:
            ZoneInfo(timezone)
        except Exception:
            timezone = ""
        await seed_demo_account(repo, identity["sub"], lang, timezone)
        await register_demo(repo, identity["sub"])
        geo = extract_client_geo(request, fallback_lang=lang)
        await record_ops_event(
            repo,
            "sign_in",
            user_id=identity["sub"],
            outcome="demo",
            country=geo["country"],
        )
        log_event("sign_in", outcome="demo", user=_pseudonym(identity["sub"]))
        background.add_task(purge_expired_demos)
        response = JSONResponse({"demo": True, "expires_at": identity["demo_exp"]})
        write_session(request, response, identity)
        return response

    @app.post("/auth/google")
    async def auth_google(body: GoogleCredential, request: Request) -> JSONResponse:
        repo = get_repository()
        geo = extract_client_geo(request, fallback_lang=body.lang)
        try:
            user = await run_in_threadpool(
                verify_google_token_claims, body.credential, settings
            )
            if not await is_email_allowed(repo, user.email, settings):
                raise AllowlistDeniedError(
                    email=user.email,
                    given_name=user.given_name,
                    user_id=user.user_id,
                )
        except AllowlistDeniedError as exc:
            try:
                # Repeat attempts must not reset an admin's decision (a revoked
                # user stays revoked) or the original request time.
                existing = await get_waitlist_entry(repo, exc.email) or {}
                now_iso = utc_now().isoformat()
                record: dict[str, Any] = {
                    "email": exc.email,
                    "given_name": exc.given_name,
                    "lang": normalize_lang(body.lang),
                    "country": geo["country"],
                    "last_attempt_at": now_iso,
                    "attempts": int(existing.get("attempts") or 0) + 1,
                }
                if not existing.get("requested_at"):
                    record["requested_at"] = now_iso
                if not existing.get("status"):
                    record["status"] = "pending"
                await save_waitlist_entry(repo, exc.email, record)
            except Exception as store_exc:
                log_event(
                    "waitlist_store_failed",
                    severity=logging.WARNING,
                    detail=str(store_exc)[:200],
                )
            await record_ops_event(
                repo,
                "sign_in",
                user_id=exc.user_id,
                email=exc.email,
                outcome="waitlisted",
                country=geo["country"],
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
            await record_ops_event(
                repo, "sign_in", outcome="denied", status=exc.status_code
            )
            log_event(
                "sign_in",
                severity=logging.WARNING,
                outcome="denied",
                status=exc.status_code,
            )
            raise
        await touch_user_presence(
            repo, user, request=request, lang=normalize_lang(body.lang)
        )
        await record_ops_event(
            repo,
            "sign_in",
            user_id=user.user_id,
            email=user.email,
            outcome="allowed",
            country=geo["country"],
        )
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
    async def auth_logout(
        request: Request, background: BackgroundTasks
    ) -> JSONResponse:
        session = read_session(request)
        if session.get("demo") and session.get("sub"):
            # Leaving the demo deletes its throwaway data right away.
            demo_id = str(session["sub"])

            async def purge() -> None:
                await purge_user_everywhere(demo_id)
                await forget_demo(get_repository(), demo_id)

            background.add_task(purge)
        response = JSONResponse({"ok": True})
        clear_session(request, response)
        return response

    @app.get("/api/me")
    async def me(request: Request, user: UserDep) -> dict[str, Any]:
        repo = get_repository()
        role, privacy_pref, prefs, _ = await asyncio.gather(
            get_user_role(repo, user, settings),
            get_user_privacy_pref(repo, user.user_id),
            get_user_prefs(repo, user.user_id),
            touch_user_presence(repo, user, request=request),
        )
        return {
            "email": user.email,
            "given_name": user.given_name,
            "picture": user.picture,
            "dev_auth_bypass": settings.dev_auth_bypass,
            "role": role,
            "is_admin": role == "admin",
            "privacy": privacy_pref,
            "preferences": prefs,
            "is_demo": user.is_demo,
            **({"demo": await demo_status(user, request)} if user.is_demo else {}),
        }

    async def demo_status(user: CurrentUser, request: Request) -> dict[str, Any]:
        limiter = app.state.limiter
        scopes = ("demo_messages_per_day", "demo_photos_per_day", "demo_voice_per_day")
        remaining = await asyncio.gather(
            *(limiter.remaining(user.user_id, s) for s in scopes)
        )
        return {
            "expires_at": int(read_session(request).get("demo_exp") or 0),
            "limits": {s: limiter.limits[s].max_hits for s in scopes},
            "remaining": dict(zip(scopes, remaining, strict=True)),
        }

    @app.post("/api/account/preferences")
    async def update_preferences(
        body: PreferencesRequest, user: UserDep
    ) -> dict[str, Any]:
        """Saves cross-device preferences so phone and desktop stay in sync."""
        prefs = await set_user_prefs(
            get_repository(), user.user_id, coach_persona=body.coach_persona
        )
        return {"ok": True, "preferences": prefs}

    # ------------------------------------------------------------- sessions
    def _usable(session: dict[str, Any] | None, timezone: str) -> bool:
        """Whether to keep using ``session`` instead of starting a new one.

        Default: one conversation per local day (new session after
        ``DAY_ROLLOVER_HOUR``, 4 am). A paused confirmation always keeps it.
        """
        if not session:
            return False
        if (
            has_pending_confirmation(session)
            and time.time() - session_last_update(session) < PENDING_CONFIRMATION_KEEP_S
        ):
            return True
        if settings.day_rollover_hour >= 0:
            hour = settings.day_rollover_hour
            return conversation_day(
                session_last_update(session), timezone, hour
            ) == conversation_day(time.time(), timezone, hour)
        if settings.session_idle_hours <= 0:
            return True
        return (
            time.time() - session_last_update(session)
            < settings.session_idle_hours * 3600
        )

    async def _user_timezone(user_id: str) -> str:
        try:
            profile = await get_repository().get_profile(user_id)
        except Exception:
            profile = None
        return (profile.timezone if profile else None) or DEFAULT_TIMEZONE

    @app.post("/api/session")
    async def open_session(
        request: Request,
        user: UserDep,
        client: AgentDep,
        body: SessionRequest | None = None,
    ) -> JSONResponse:
        """Reuses today's conversation or starts a new one.

        Conversations roll over once per local day (``DAY_ROLLOVER_HOUR``), so
        the first visit of a day starts fresh and the coach runs its check-ins
        (FR-8). Earlier days stay readable via ``GET /api/history/older``.
        """
        cookie = read_session(request)
        timezone = await _user_timezone(user.user_id)

        async def choose() -> dict[str, Any]:
            chosen: dict[str, Any] | None = None
            if not (body and body.new):
                if cookie.get("sid") and cookie.get("sid_user") == user.user_id:
                    candidate = await client.get_session(
                        user.user_id, str(cookie["sid"])
                    )
                    chosen = candidate if _usable(candidate, timezone) else None
                if chosen is None:
                    sessions = await client.list_sessions(user.user_id)
                    if sessions:
                        latest = max(sessions, key=session_last_update)
                        candidate = await client.get_session(
                            user.user_id, str(latest["id"])
                        )
                        chosen = candidate if _usable(candidate, timezone) else None
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
                await record_ops_event(
                    get_repository(),
                    "system_error",
                    user_id=user.user_id,
                    email=user.email,
                    source="open_session_failed",
                    error=type(exc).__name__,
                )
                raise HTTPException(
                    status_code=502, detail="The coach is unavailable right now."
                ) from exc
        session_id = str(chosen["id"])
        events = session_events(chosen)
        is_new = not events
        repo = get_repository()
        await touch_user_presence(repo, user, request=request)
        log_event(
            "open_session",
            user=_pseudonym(user.user_id),
            session_id=session_id,
            is_new=is_new,
        )
        started = session_started_at(chosen) if not is_new else time.time()
        payload: dict[str, Any] = {
            "session_id": session_id,
            "is_new": is_new,
            "started_at": started,
            "day": conversation_day(started, timezone, settings.day_rollover_hour),
        }
        if body and body.include_history and not is_new:
            for entry_id, (mime, raw_bytes) in extract_meal_photos_from_events(
                events
            ).items():
                await save_meal_photo(repo, user.user_id, entry_id, mime, raw_bytes)
            payload["history"] = build_history(events)
        response = JSONResponse(payload)
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

    @app.get("/api/history/older")
    async def older_history(
        user: UserDep,
        client: AgentDep,
        before: float = Query(..., gt=0, description="Epoch seconds (exclusive)."),
    ) -> dict[str, Any]:
        """The most recent earlier conversation that started before ``before``.

        Powers the continuous chat timeline: the client scrolls up and asks for
        one earlier conversation at a time (empty sessions are skipped).
        Pending confirmations of old sessions are not actionable, so they are
        dropped.
        """
        timezone = await _user_timezone(user.user_id)
        with web_span("history_older", backend=settings.agent_backend):
            try:
                sessions = await asyncio.wait_for(
                    client.list_sessions(user.user_id), SESSION_TIMEOUT_S
                )
            except TimeoutError as exc:
                raise HTTPException(
                    status_code=504, detail="Loading older messages took too long."
                ) from exc
            # Sessions that ended before ``before`` (newest first).
            candidates = sorted(
                (s for s in sessions if 0 < session_last_update(s) < before),
                key=session_last_update,
                reverse=True,
            )
            for index, meta in enumerate(candidates[:8]):
                session = await client.get_session(user.user_id, str(meta["id"]))
                events = session_events(session)
                hist = build_history(events)
                if not hist["messages"]:
                    continue
                started = session_started_at(session)
                return {
                    "session_id": str(meta["id"]),
                    "started_at": started,
                    "day": conversation_day(
                        started, timezone, settings.day_rollover_hour
                    ),
                    "messages": hist["messages"],
                    "has_more": index + 1 < len(candidates),
                }
        return {"session_id": None, "messages": [], "has_more": False}

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
        events = session_events(session)
        repo = get_repository()
        for entry_id, (mime, raw_bytes) in extract_meal_photos_from_events(
            events
        ).items():
            await save_meal_photo(repo, user.user_id, entry_id, mime, raw_bytes)
        return {"session_id": session_id, **build_history(events)}

    # ------------------------------------------------------------ streaming
    # One agent run per conversation at a time. Runs are pumped by a background
    # task, so they finish (and we know when) even if the browser disconnects;
    # Cloud Run session affinity keeps a browser on the same instance.
    _inflight: dict[str, asyncio.Task[None]] = {}

    async def _run_events(
        client: AgentClient, user_id: str, session_id: str, message: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

        async def pump() -> None:
            try:
                async for raw in client.stream_query(user_id, session_id, message):
                    await queue.put(("event", raw))
            except Exception as exc:  # re-raised in the consumer
                await queue.put(("error", exc))
            finally:
                await queue.put(("end", None))

        task = asyncio.create_task(pump())
        _inflight[session_id] = task
        task.add_done_callback(
            lambda t: (
                _inflight.pop(session_id, None)
                if _inflight.get(session_id) is t
                else None
            )
        )
        while True:
            kind, item = await queue.get()
            if kind == "end":
                return
            if kind == "error":
                raise item
            yield item

    async def _decline_stale_confirmations(
        client: AgentClient, user_id: str, session_id: str
    ) -> int:
        """Answers every unanswered confirmation in the session with 'reject'."""
        session = await client.get_session(user_id, session_id)
        pending = (
            build_history(session_events(session))["pending_confirmations"]
            if session
            else []
        )
        for card in pending:
            decline = {
                "role": "user",
                "parts": [
                    {
                        "functionResponse": {
                            "id": card["call_id"],
                            "name": CONFIRMATION_CALL,
                            "response": {"confirmed": False},
                        }
                    }
                ],
            }
            with contextlib.suppress(Exception):
                async for _ in _run_events(client, user_id, session_id, decline):
                    pass
        return len(pending)

    async def stream_turn(
        user: CurrentUser,
        session_id: str,
        message: dict[str, Any],
        intent: str,
        preview: str,
        lang: str = "en",
        request: Request | None = None,
    ) -> AsyncIterator[str]:
        """Runs one agent turn and yields simplified events as SSE frames."""
        client: AgentClient = app.state.agent
        started = time.monotonic()
        counts = {"text": 0, "activity": 0, "confirmation": 0, "error": 0}
        outcome = "ok"
        error_detail = ""
        last_activity: str | None = None
        span = start_web_span(
            "agent_turn",
            backend=settings.agent_backend,
            intent=intent,
            session_id=session_id,
        )
        replies = 0
        agents_seen: set[str] = set()
        waited_for_previous = False

        async def frames(msg: dict[str, Any]) -> AsyncIterator[str]:
            nonlocal last_activity, replies
            async for raw in _run_events(client, user.user_id, session_id, msg):
                author = str(raw.get("author") or "") if isinstance(raw, dict) else ""
                if author and author != "user":
                    agents_seen.add(author)
                for event in simplify_event(raw, lang):
                    if event["type"] == "activity":
                        if event["label"] == last_activity:
                            continue
                        last_activity = event["label"]
                    else:
                        last_activity = None
                        replies += 1
                    if (
                        event["type"] == "card"
                        and event.get("kind") == "meal_logged"
                        and event.get("entry_id")
                    ):
                        entry_id = str(event["entry_id"])
                        repo = get_repository()
                        pending_photo = await get_pending_meal_photo(
                            repo, user.user_id, session_id
                        )
                        if pending_photo is not None:
                            await save_meal_photo(
                                repo,
                                user.user_id,
                                entry_id,
                                pending_photo[0],
                                pending_photo[1],
                            )
                            event["photo_url"] = f"/api/meals/{entry_id}/photo"
                    counts[event["type"]] = counts.get(event["type"], 0) + 1
                    yield _sse(event)

        try:
            previous = _inflight.get(session_id)
            if previous is not None and not previous.done():
                # The browser lost the stream (phone locked, app switched) but
                # the reply is still being produced: wait for it instead of
                # interleaving a second run into the same conversation.
                waited_for_previous = True
                yield _sse({"type": "activity", "label": _label("busy", lang)})
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(asyncio.shield(previous), INFLIGHT_WAIT_S)
            async for frame in frames(message):
                yield frame
            is_text_turn = not any("functionResponse" in p for p in message["parts"])
            if replies == 0 and is_text_turn:
                # A message sent while the run was paused on an unanswered
                # Confirm / Reject card resumes that run and gets no reply.
                # Decline the stale card(s), then deliver the message again.
                cleared = await _decline_stale_confirmations(
                    client, user.user_id, session_id
                )
                if cleared:
                    log_event(
                        "stale_confirmations_declined",
                        user=_pseudonym(user.user_id),
                        session_id=session_id,
                        count=cleared,
                    )
                    yield _sse({"type": "activity", "label": _label("declined", lang)})
                    async for frame in frames(message):
                        yield frame
            if replies == 0 and is_text_turn and intent != "greeting":
                counts["error"] += 1
                yield _sse({"type": "error", "message": _label("no_reply", lang)})
        except AgentError as exc:
            outcome = "agent_error"
            error_detail = str(exc)[:160]
            counts["error"] += 1
            yield _sse({"type": "error", "message": localize(str(exc), lang)})
        except Exception as exc:  # never leak internals to the browser
            outcome = "error"
            error_detail = type(exc).__name__
            counts["error"] += 1
            span.record_exception(exc)
            log_event(
                "agent_turn_exception", severity=logging.ERROR, error=type(exc).__name__
            )
            yield _sse(
                {
                    "type": "error",
                    "message": localize(
                        "The coach is unavailable right now. Please try again.", lang
                    ),
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
            repo = get_repository()
            has_img = intent == "photo"
            cost_meta = estimate_turn_tokens_and_cost(
                intent=intent,
                input_chars=len(preview),
                has_image=has_img,
                activity_events=counts["activity"],
                confirmation_events=counts["confirmation"],
                text_events=counts["text"],
            )
            is_err = outcome in ("agent_error", "error")
            await touch_user_presence(
                repo,
                user,
                request=request,
                lang=lang,
                increment_turn=True,
                increment_photo=has_img,
                increment_error=is_err,
            )
            await record_ops_event(
                repo,
                "chat_turn",
                user_id=user.user_id,
                email=user.email,
                intent=intent,
                outcome=outcome,
                latency_ms=latency_ms,
                has_image=has_img,
                input_chars=len(preview),
                agents=sorted(agents_seen),
                **{f"{k}_events": v for k, v in counts.items()},
                **cost_meta,
            )
            if is_err:
                await record_ops_event(
                    repo,
                    "system_error",
                    user_id=user.user_id,
                    email=user.email,
                    source=(
                        "agent_turn_exception" if outcome == "error" else "agent_error"
                    ),
                    error=error_detail or outcome,
                )
            u_pref = await get_user_privacy_pref(repo, user.user_id)
            log_preview = (
                preview
                if u_pref.get("share_usage_data", True)
                else f"[redacted_by_pdpa_privacy_pref len={len(preview)}]"
            )
            log_event(
                "chat_turn",
                severity=logging.INFO
                if outcome in ("ok", "awaiting_confirmation")
                else logging.WARNING,
                intent=intent,
                request=log_preview,
                outcome=outcome,
                latency_ms=latency_ms,
                user=_pseudonym(user.user_id),
                session_id=session_id,
                **{f"{k}_events": v for k, v in counts.items()},
            )
        if waited_for_previous:
            # The previous reply finished in the background while this request
            # waited: tell the browser to reload the conversation so it shows.
            yield _sse({"type": "resync"})
        yield _sse({"type": "done"})

    def _sse_response(generator: AsyncIterator[str]) -> StreamingResponse:
        return StreamingResponse(
            with_heartbeat(generator),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/transcribe")
    async def transcribe(
        user: UserDep,
        audio: Annotated[UploadFile, File()],
        lang: Annotated[str | None, Form()] = None,
    ) -> JSONResponse:
        """Speech-to-text for voice messages (the transcript is then sent as chat text)."""
        if limited := await rate_limited(
            user, ["messages_per_minute", "voice_per_day"]
        ):
            return limited
        data = await audio.read(MAX_AUDIO_BYTES + 1)
        if len(data) > MAX_AUDIO_BYTES:
            raise HTTPException(
                status_code=413, detail="Voice messages are limited to about 2 minutes."
            )
        mime = sniff_audio(data)
        if mime is None:
            raise HTTPException(status_code=415, detail="Unsupported audio format.")
        try:
            result = await transcribe_audio(data, mime, normalize_lang(lang))
        except Exception as exc:
            raise HTTPException(
                status_code=502, detail="Could not transcribe that recording."
            ) from exc
        log_event(
            "voice_transcribed",
            user=_pseudonym(user.user_id),
            chars=len(result["text"]),
            status=result["status"],
            bytes=len(data),
        )
        return JSONResponse(result)

    @app.post("/api/chat")
    async def chat(
        request: Request,
        user: UserDep,
        text: Annotated[str, Form()] = "",
        image: Annotated[UploadFile | None, File()] = None,
        lang: Annotated[str | None, Form()] = None,
        persona: Annotated[str | None, Form()] = None,
        voice: Annotated[str | None, Form()] = None,
    ) -> StreamingResponse:
        session_id = active_session_id(request, user)
        text = text.strip()
        if len(text) > MAX_TEXT_CHARS:
            raise HTTPException(
                status_code=413,
                detail=f"Messages are limited to {MAX_TEXT_CHARS} characters.",
            )
        norm_lang = normalize_lang(lang)
        if not persona:
            # Fall back to the persona saved for this account (other device).
            persona = (await get_user_prefs(get_repository(), user.user_id)).get(
                "coach_persona"
            )
        parts: list[dict[str, Any]] = []
        uploaded_photo: tuple[str, bytes] | None = None
        if text:
            prefix = (
                build_persona_prefix(persona, norm_lang)
                if text not in GREETING_TEXTS.values()
                else ""
            )
            marker = VOICE_MARKER if voice == "1" else ""
            parts.append({"text": f"{prefix}{marker}{text}"})
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
            uploaded_photo = (mime, data)
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
        # The UI language travels with every turn (also photo-only ones), so
        # replies and names the agents create (foods, plans) match the UI.
        parts.append(ui_language_part(norm_lang))
        if text in GREETING_TEXTS.values():
            intent = "greeting"
        elif any("inlineData" in p for p in parts):
            intent = "photo"
        else:
            intent = "message"
        if intent != "greeting":
            scopes = ["messages_per_minute", "messages_per_day"]
            if intent == "photo":
                scopes.append("photos_per_day")
            if limited := await rate_limited(user, scopes):
                return limited
        if uploaded_photo is not None:
            await save_pending_meal_photo(
                get_repository(),
                user.user_id,
                session_id,
                uploaded_photo[0],
                uploaded_photo[1],
            )
        preview = redact_text(text) + (" [+photo]" if intent == "photo" else "")
        message = {"role": "user", "parts": parts}
        return _sse_response(
            stream_turn(
                user,
                session_id,
                message,
                intent,
                preview,
                norm_lang,
                request=request,
            )
        )

    async def live_frame_limited(user: CurrentUser) -> dict[str, Any] | None:
        """Daily cap on live form-coach frames (each one is a Gemini vision call)."""
        decision = await app.state.limiter.hit(user.user_id, ["live_frames_per_day"])
        if decision.allowed:
            return None
        log_event("rate_limited", user=user.user_id, scope="live_frames_per_day")
        return {
            "ok": True,
            "status": "daily_limit",
            "score": None,
            "voice_cue": "",
            "checks": [],
            "rep_increment": 0,
            "retry_after": decision.retry_after,
        }

    @app.post("/api/form-check")
    async def form_check(
        request: Request,
        user: UserDep,
        exercise_id: Annotated[str, Form()] = "",
        exercise_name: Annotated[str, Form()] = "",
        lang: Annotated[str | None, Form()] = None,
        persona: Annotated[str | None, Form()] = None,
        frame_index: Annotated[int, Form()] = 0,
        simulation: Annotated[str | None, Form()] = None,
        frame_hint: Annotated[str | None, Form()] = None,
        image: Annotated[UploadFile | None, File()] = None,
    ) -> dict[str, Any]:
        """Analyzes a live camera frame for real-time exercise form & voice coaching."""
        if user.is_demo:
            raise HTTPException(
                status_code=403, detail="Live form coaching needs a signed-in account."
            )
        data = b""
        mime = "image/jpeg"
        if image is not None and (image.filename or image.size):
            data = await image.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="Frame is too large.")
            sniffed = _sniff_image(data)
            if sniffed not in ALLOWED_IMAGE_TYPES:
                raise HTTPException(
                    status_code=415, detail="Please upload a JPEG, PNG or WebP frame."
                )
            mime = sniffed
        norm_lang = normalize_lang(lang)
        is_sim = str(simulation or "").strip().lower() in ("1", "true", "yes")
        if data and not is_sim and (capped := await live_frame_limited(user)):
            return capped
        result = await analyze_exercise_form(
            exercise_id=exercise_id.strip()[:80],
            exercise_name=exercise_name.strip()[:80],
            image_bytes=data,
            mime_type=mime,
            lang=norm_lang,
            frame_index=max(0, min(frame_index, 10000)),
            persona=(persona or "").strip()[:40],
            simulation=is_sim,
            frame_hint=(frame_hint or "").strip()[:40],
        )
        repo = get_repository()
        await touch_user_presence(repo, user, request=request, lang=norm_lang)
        await record_ops_event(
            repo,
            "telemetry",
            user_id=user.user_id,
            email=user.email,
            name="form_check",
            exercise_id=exercise_id.strip()[:40],
            score=result.get("score"),
        )
        return result

    @app.post("/api/tts")
    async def coach_tts(body: TtsRequest, user: UserDep) -> dict[str, Any]:
        """Synthesizes natural neural speech for the active coach persona."""
        if user.is_demo and await rate_limited(user, ["demo_tts_per_day"]):
            return {"ok": False, "reason": "demo_limit"}
        res = await synthesize_coach_speech(
            text=body.text,
            persona=body.persona,
            lang=normalize_lang(body.lang),
        )
        if not res:
            return {"ok": False}
        return {"ok": True, **res}

    @app.post("/api/internal/form-check")
    async def internal_form_check(
        request: Request,
        exercise_id: Annotated[str, Form()] = "",
        exercise_name: Annotated[str, Form()] = "",
        lang: Annotated[str | None, Form()] = None,
        persona: Annotated[str | None, Form()] = None,
        frame_index: Annotated[int, Form()] = 0,
        include_tts: Annotated[str | None, Form()] = "1",
        image: Annotated[UploadFile | None, File()] = None,
    ) -> dict[str, Any]:
        """Internal worker route executed by fitness-buddy-vision (agent SA)."""
        if request.headers.get("X-Coach-Internal") != "fitness-buddy-internal-v1":
            raise HTTPException(status_code=403, detail="Forbidden")
        data = await image.read(MAX_IMAGE_BYTES) if image is not None else b""
        mime = (_sniff_image(data) if data else None) or "image/jpeg"
        want_tts = str(include_tts or "1").strip() != "0"
        return await analyze_exercise_form(
            exercise_id=exercise_id.strip()[:80],
            exercise_name=exercise_name.strip()[:80],
            image_bytes=data,
            mime_type=mime,
            lang=normalize_lang(lang),
            frame_index=max(0, min(frame_index, 10000)),
            persona=(persona or "").strip()[:40],
            include_tts=want_tts,
            enable_gemini=True,
        )

    @app.post("/api/internal/tts")
    async def internal_tts(request: Request, body: TtsRequest) -> dict[str, Any]:
        """Internal worker route for Gemini 2.5 Native Audio TTS."""
        if request.headers.get("X-Coach-Internal") != "fitness-buddy-internal-v1":
            raise HTTPException(status_code=403, detail="Forbidden")
        res = await synthesize_coach_speech(
            text=body.text,
            persona=body.persona,
            lang=normalize_lang(body.lang),
        )
        if not res:
            return {"ok": False}
        return {"ok": True, **res}

    @app.websocket("/api/live-coach/ws")
    async def live_coach_ws(websocket: WebSocket) -> None:
        """Scheme C: Bidirectional WebSocket stream for real-time form coaching & voice."""
        try:
            user = current_user(websocket)  # type: ignore[arg-type]
        except HTTPException:
            await websocket.close(code=4401)
            return

        if user.is_demo:
            await websocket.close(code=4403)
            return
        await websocket.accept()
        await websocket.send_json({"type": "ready", "mode": "live_ws_stream"})
        repo = get_repository()

        try:
            while True:
                msg = await websocket.receive_json()
                if not isinstance(msg, dict):
                    continue
                msg_type = str(msg.get("type") or "").strip().lower()
                if msg_type == "ping":
                    await websocket.send_json({"type": "pong"})
                    continue
                if msg_type != "frame":
                    continue

                ex_id = str(msg.get("exercise_id") or "").strip()[:80]
                ex_name = str(msg.get("exercise_name") or "").strip()[:80]
                norm_lang = normalize_lang(str(msg.get("lang") or "zh"))
                persona_id = str(msg.get("persona") or "iron_leo").strip()[:40]
                try:
                    f_idx = max(0, min(int(msg.get("frame_index") or 0), 10000))
                except (TypeError, ValueError):
                    f_idx = 0
                is_sim = bool(msg.get("simulation"))
                frame_hint = str(msg.get("frame_hint") or "").strip()[:40]
                want_voice = bool(msg.get("voice_enabled", True))

                raw_b64 = str(msg.get("image_b64") or "").strip()
                if "," in raw_b64 and raw_b64.startswith("data:"):
                    raw_b64 = raw_b64.split(",", 1)[1]
                img_bytes = b""
                if raw_b64:
                    try:
                        img_bytes = base64.b64decode(raw_b64)
                    except Exception:
                        img_bytes = b""
                if len(img_bytes) > MAX_IMAGE_BYTES:
                    img_bytes = b""
                mime = (_sniff_image(img_bytes) if img_bytes else None) or "image/jpeg"
                if (
                    img_bytes
                    and not is_sim
                    and (capped := await live_frame_limited(user))
                ):
                    await websocket.send_json(
                        {"type": "vision_result", "frame_index": f_idx, **capped}
                    )
                    continue

                # Stage 1: Fast visual evidence + biomechanical check (push HUD immediately)
                vision_res = await analyze_exercise_form(
                    exercise_id=ex_id,
                    exercise_name=ex_name,
                    image_bytes=img_bytes,
                    mime_type=mime,
                    lang=norm_lang,
                    frame_index=f_idx,
                    persona=persona_id,
                    simulation=is_sim,
                    frame_hint=frame_hint,
                    include_tts=False,
                )
                await websocket.send_json(
                    {
                        "type": "vision_result",
                        "frame_index": f_idx,
                        **vision_res,
                    }
                )

                # Stage 2: Stream neural voice audio packet for the cue
                cue_text = str(vision_res.get("voice_cue") or "").strip()
                if want_voice and cue_text:
                    tts = await synthesize_coach_speech(
                        cue_text, persona=persona_id, lang=norm_lang
                    )
                    if tts and tts.get("audio_b64"):
                        await websocket.send_json(
                            {
                                "type": "voice_audio",
                                "frame_index": f_idx,
                                "voice_cue": cue_text,
                                "audio_b64": tts["audio_b64"],
                                "audio_mime": tts["audio_mime"],
                                "tts_source": tts.get("source", ""),
                            }
                        )
                    else:
                        await websocket.send_json(
                            {
                                "type": "voice_audio_done",
                                "frame_index": f_idx,
                            }
                        )

                await record_ops_event(
                    repo,
                    "telemetry",
                    user_id=user.user_id,
                    email=user.email,
                    name="form_check_ws",
                    exercise_id=ex_id[:40],
                    score=vision_res.get("score"),
                )
        except WebSocketDisconnect:
            return
        except Exception as exc:
            log_event(
                "live_coach_ws_closed",
                severity=logging.WARNING,
                error=type(exc).__name__,
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
                user,
                session_id,
                message,
                intent,
                intent,
                normalize_lang(body.lang),
                request=request,
            )
        )

    # ------------------------------------------------------------ dashboard
    @app.get("/api/meals/{entry_id}/photo")
    async def meal_photo(
        entry_id: str,
        request: Request,
        user: UserDep,
        client: AgentDep,
    ) -> Response:
        """Serves the uploaded photo for one of the user's logged meals."""
        repo = get_repository()
        found = await get_meal_photo(repo, user.user_id, entry_id)
        if found is None:
            # Backfill from the active session or recent sessions if logged before photo indexing.
            session_ids: list[str] = []
            cookie = read_session(request)
            if cookie.get("sid") and cookie.get("sid_user") == user.user_id:
                session_ids.append(str(cookie["sid"]))
            try:
                sessions = await asyncio.wait_for(
                    client.list_sessions(user.user_id), SESSION_TIMEOUT_S
                )
                for meta in sorted(sessions, key=session_last_update, reverse=True)[:5]:
                    sid = str(meta.get("id") or "")
                    if sid and sid not in session_ids:
                        session_ids.append(sid)
            except Exception:
                pass
            for sid in session_ids:
                try:
                    session = await asyncio.wait_for(
                        client.get_session(user.user_id, sid), SESSION_TIMEOUT_S
                    )
                except Exception:
                    continue
                if not session:
                    continue
                extracted = extract_meal_photos_from_events(session_events(session))
                for k_id, (mime, raw_bytes) in extracted.items():
                    await save_meal_photo(repo, user.user_id, k_id, mime, raw_bytes)
                if entry_id in extracted:
                    found = extracted[entry_id]
                    break
        if found is None:
            raise HTTPException(status_code=404, detail="Meal photo not found.")
        mime, raw_bytes = found
        return Response(
            content=raw_bytes,
            media_type=mime,
            headers={"Cache-Control": "private, max-age=86400"},
        )

    @app.get("/api/workouts")
    async def workout_history(
        user: UserDep,
        before: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
        days: int = Query(default=30, ge=1, le=120),
    ) -> dict[str, Any]:
        """Logged workouts with sets, reps, loads, effort and notes, vs. the plan."""
        return await build_workout_history(
            get_repository(),
            user.user_id,
            before=date.fromisoformat(before) if before else None,
            days=days,
        )

    @app.get("/api/dashboard")
    async def dashboard(
        request: Request, user: UserDep, range: int | None = None
    ) -> dict[str, Any]:
        repo = get_repository()
        with web_span("dashboard"):
            try:
                data = await asyncio.wait_for(
                    build_dashboard(repo, user.user_id, range_days=range),
                    DASHBOARD_TIMEOUT_S,
                )
            except TimeoutError as exc:
                log_event("dashboard_timeout", severity=logging.ERROR)
                await record_ops_event(
                    repo,
                    "system_error",
                    user_id=user.user_id,
                    email=user.email,
                    source="dashboard_timeout",
                    error="TimeoutError",
                )
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
                await record_ops_event(
                    repo,
                    "system_error",
                    user_id=user.user_id,
                    email=user.email,
                    source="dashboard_failed",
                    error=type(exc).__name__,
                )
                raise HTTPException(
                    status_code=502, detail="Could not load your progress right now."
                ) from exc
        tz = str((data.get("profile") or {}).get("timezone") or "")
        await touch_user_presence(
            repo,
            user,
            request=request,
            timezone=tz or None,
            onboarding_completed=bool(data.get("has_profile")),
        )
        return data

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
            await record_ops_event(
                get_repository(),
                "system_error",
                user_id=user.user_id,
                email=user.email,
                source="feedback_store_failed",
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
    async def telemetry(
        request: Request, body: TelemetryRequest, user: UserDep
    ) -> None:
        """Product analytics for UI interactions; unknown event names are ignored."""
        if body.name not in TELEMETRY_EVENTS:
            return None
        props = {
            str(k)[:40]: (v[:60] if isinstance(v, str) else v)
            for k, v in body.props.items()
            if str(k).isidentifier()
        }
        repo = get_repository()
        lang_prop = str(props.get("lang") or "") if "lang" in props else None
        await touch_user_presence(
            repo,
            user,
            request=request,
            lang=lang_prop,
            onboarding_completed=(body.name == "onboarding_complete"),
        )
        await record_ops_event(
            repo,
            "ui_event",
            user_id=user.user_id,
            email=user.email,
            name=body.name,
            **props,
        )
        log_event("ui_event", name=body.name, user=_pseudonym(user.user_id), **props)
        return None

    # ------------------------------------------------------------ admin console (RBAC)
    async def require_admin(user: CurrentUser) -> CurrentUser:
        role = await get_user_role(get_repository(), user, settings)
        if role != "admin":
            raise HTTPException(
                status_code=403,
                detail="Admin role required to access the management console.",
            )
        return user

    @app.get("/api/admin/overview")
    async def admin_overview(
        request: Request,
        user: UserDep,
        days: int = 14,
    ) -> dict[str, Any]:
        """Returns all operational metrics and waitlist/allowlist records (admin only)."""
        admin = await require_admin(user)
        repo = get_repository()
        await touch_user_presence(repo, admin, request=request)
        return await asyncio.wait_for(
            build_admin_overview(
                repo, settings, days=days, asset_version=ASSET_VERSION
            ),
            DASHBOARD_TIMEOUT_S,
        )

    @app.post("/api/admin/users")
    async def admin_update_user(
        body: AdminAccessRequest,
        user: UserDep,
    ) -> dict[str, Any]:
        """Approves, revokes, or updates a user's allowlist status and role (admin only)."""
        admin = await require_admin(user)
        clean_email = body.email.strip().lower()
        if "@" not in clean_email or "." not in clean_email.split("@", 1)[-1]:
            raise HTTPException(
                status_code=422, detail="Please enter a valid e-mail address."
            )
        status = body.status
        role = body.role
        if clean_email in settings.admin_emails:
            if status == "revoked":
                raise HTTPException(
                    status_code=400,
                    detail="Primary admin accounts configured in ADMIN_EMAILS cannot be revoked.",
                )
            status = "approved"
            role = "admin"
        record = await update_access_entry(
            get_repository(),
            email=clean_email,
            status=status,
            role=role,
            given_name=body.given_name,
            note=body.note,
            updated_by=admin.email,
        )
        log_event(
            "admin_access_updated",
            admin=_pseudonym(admin.user_id),
            target_status=status,
            target_role=role,
        )
        return {"ok": True, "entry": record}

    # ------------------------------------------------------------ coach memory
    @app.get("/api/memories")
    async def list_memories(user: UserDep) -> dict[str, Any]:
        """Lists the user's Coach Memory (durable facts shared by all coaches)."""
        memories = await get_repository().list_memories(user.user_id)
        return {
            "memories": [
                m.model_dump(mode="json", exclude={"user_id"}) for m in memories
            ],
            "max": MAX_MEMORIES,
            "categories": list(MEMORY_CATEGORIES),
        }

    @app.post("/api/memories")
    async def add_memory(body: MemoryRequest, user: UserDep) -> dict[str, Any]:
        """Adds or edits a memory on the user's behalf."""
        result = await remember(
            get_repository(),
            user.user_id,
            body.text,
            category=body.category,
            source="user",
            replaces_memory_id=body.replaces_memory_id,
        )
        if result.get("status") == "error":
            raise HTTPException(status_code=400, detail=result["error_message"])
        memory = dict(result["memory"])
        memory.pop("user_id", None)
        return {"status": result["status"], "memory": memory}

    @app.delete("/api/memories/{memory_id}")
    async def delete_memory(memory_id: str, user: UserDep) -> dict[str, Any]:
        """Forgets one memory."""
        ok = await get_repository().delete_memory(user.user_id, memory_id[:40])
        if not ok:
            raise HTTPException(status_code=404, detail="Memory not found.")
        return {"ok": True}

    @app.delete("/api/memories")
    async def clear_memories(user: UserDep) -> dict[str, Any]:
        """Forgets every Coach Memory entry for this user."""
        repo = get_repository()
        memories = await repo.list_memories(user.user_id)
        for m in memories:
            await repo.delete_memory(user.user_id, m.memory_id)
        return {"ok": True, "deleted": len(memories)}

    # ------------------------------------------------------------ account (privacy)
    @app.get("/api/account/privacy")
    async def get_privacy_settings(user: UserDep) -> dict[str, Any]:
        """Returns the user's PDPA privacy and usage-data sharing preferences."""
        pref = await get_user_privacy_pref(get_repository(), user.user_id)
        return {"ok": True, "privacy": pref}

    @app.post("/api/account/privacy")
    async def update_privacy_settings(
        body: PrivacySettingsRequest, user: UserDep
    ) -> dict[str, Any]:
        """Updates the user's PDPA usage-data sharing consent and purges historical telemetry on withdrawal."""
        result = await set_user_privacy_pref(
            get_repository(),
            user,
            share_usage_data=bool(body.share_usage_data),
        )
        log_event(
            "account_privacy_updated",
            user=_pseudonym(user.user_id),
            share_usage_data=bool(body.share_usage_data),
        )
        return {"ok": True, "privacy": result}

    @app.get("/api/account/export")
    async def export_account(user: UserDep, client: AgentDep) -> JSONResponse:
        """Self-service data export: stored data, conversations and coach memories."""
        repo = get_repository()
        data = await repo.export_user_data(user.user_id)
        privacy_pref = await get_user_privacy_pref(repo, user.user_id)
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
            "privacy_preferences": privacy_pref,
            "data": data,
            "conversations": conversations,
            "coach_memories": memories,
        }
        filename = f"fitness-buddy-export-{utc_now().date().isoformat()}.json"
        return JSONResponse(
            payload,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # ------------------------------------------------------------ push reminders
    @app.get("/api/push/config")
    async def push_config(user: UserDep) -> dict[str, Any]:
        """VAPID public key for PushManager.subscribe (reminders are off without it)."""
        config: PushConfig = app.state.push
        return {
            "enabled": config.enabled and not user.is_demo,
            "public_key": config.public_key if config.enabled else "",
        }

    @app.post("/api/push/subscribe")
    async def push_subscribe(
        body: PushSubscribeRequest, user: UserDep
    ) -> dict[str, Any]:
        """Stores this browser's push subscription for the signed-in user."""
        if user.is_demo:
            raise HTTPException(
                status_code=403, detail="Reminders need a signed-in account."
            )
        if not app.state.push.enabled:
            raise HTTPException(status_code=503, detail="Reminders are not configured.")
        repo = get_repository()
        existing = await get_subscription(repo, body.subscription.endpoint) or {}
        prefs = {
            "training": True,
            "meals": True,
            **(existing.get("prefs") or {}),
            **body.prefs,
        }
        await save_subscription(
            repo,
            {
                "endpoint": body.subscription.endpoint,
                "keys": body.subscription.keys.model_dump(),
                "user_id": user.user_id,
                "lang": normalize_lang(body.lang),
                "timezone": (body.timezone or "")[:64],
                "prefs": prefs,
                "created_at": existing.get("created_at") or utc_now().isoformat(),
                "updated_at": utc_now().isoformat(),
            },
        )
        log_event("push_subscribed", user=_pseudonym(user.user_id))
        return {"subscribed": True, "prefs": prefs}

    @app.post("/api/push/status")
    async def push_status(body: PushEndpointRequest, user: UserDep) -> dict[str, Any]:
        """Whether this browser's subscription is registered (and its preferences)."""
        sub = await get_subscription(get_repository(), body.endpoint)
        if not sub or sub.get("user_id") != user.user_id:
            return {"subscribed": False}
        return {"subscribed": True, "prefs": sub.get("prefs") or {}}

    @app.post("/api/push/prefs")
    async def push_prefs(body: PushEndpointRequest, user: UserDep) -> dict[str, Any]:
        repo = get_repository()
        sub = await get_subscription(repo, body.endpoint)
        if not sub or sub.get("user_id") != user.user_id:
            raise HTTPException(
                status_code=404, detail="Not subscribed on this device."
            )
        prefs = {**(sub.get("prefs") or {}), **(body.prefs or {})}
        await save_subscription(repo, {"endpoint": body.endpoint, "prefs": prefs})
        return {"subscribed": True, "prefs": prefs}

    @app.post("/api/push/unsubscribe")
    async def push_unsubscribe(
        body: PushEndpointRequest, user: UserDep
    ) -> dict[str, Any]:
        repo = get_repository()
        sub = await get_subscription(repo, body.endpoint)
        if sub and sub.get("user_id") == user.user_id:
            await delete_subscription(repo, body.endpoint)
        return {"subscribed": False}

    @app.post("/api/push/test")
    async def push_test(user: UserDep, lang: str | None = None) -> dict[str, Any]:
        """Sends a confirmation notification to every device of the user."""
        if not app.state.push.enabled:
            raise HTTPException(status_code=503, detail="Reminders are not configured.")
        repo = get_repository()
        sent = 0
        for sub in await list_subscriptions(repo, user.user_id):
            payload = push_message("test", normalize_lang(lang or sub.get("lang")))
            sent += int(await send_push(app.state.push, repo, sub, payload))
        return {"sent": sent}

    @app.post("/api/internal/push/dispatch")
    async def push_dispatch(request: Request) -> dict[str, Any]:
        """Hourly Cloud Scheduler job: sends the reminders that are due now."""
        config: PushConfig = app.state.push
        token = request.headers.get("X-Push-Token", "")
        if not config.dispatch_token or not hmac.compare_digest(
            token, config.dispatch_token
        ):
            raise HTTPException(status_code=403, detail="Forbidden")
        if not config.enabled:
            return {"enabled": False}
        stats = await dispatch_push(config, get_repository())
        log_event("push_dispatch", **stats)
        return stats

    @app.post("/api/account/delete")
    async def delete_account(
        request: Request, body: DeleteAccountRequest, user: UserDep, client: AgentDep
    ) -> JSONResponse:
        """Deletes the user's stored data, conversations and coach memories."""
        result = await purge_user_everywhere(user.user_id)
        errors: list[str] = result.get("incomplete", [])
        if user.is_demo:
            await forget_demo(get_repository(), user.user_id)
        log_event(
            "account_deleted",
            severity=logging.WARNING if errors else logging.INFO,
            user=_pseudonym(user.user_id),
            errors=errors,
            **{k: v for k, v in result.items() if k not in ("deleted", "incomplete")},
        )
        response = JSONResponse(result)
        clear_session(request, response)
        return response

    return app


app = create_app()
