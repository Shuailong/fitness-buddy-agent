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

"""Sign in with Google + allowlist, and a signed session cookie (FR-13).

Flow: the browser renders the Google Identity Services button and receives an
ID token (JWT). ``POST /auth/google`` verifies the token's signature, audience
and expiry with ``google.oauth2.id_token``, requires a verified e-mail that is
on the ``ALLOWED_EMAILS`` allowlist, and then stores the account's stable
``sub`` in an HMAC-signed, HttpOnly, SameSite=Lax cookie. That ``sub`` is the
ADK ``user_id`` for sessions, Firestore documents and Memory Bank, so every
user only ever sees their own data.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request, Response

from web.config import WebSettings

COOKIE_NAME = "fb_session"
DEV_USER_ID = "dev-user"
DEV_USER_EMAIL = "dev@localhost"


@dataclass(frozen=True)
class CurrentUser:
    """The signed-in user. ``user_id`` is the Google ``sub`` (or ``dev-user``)."""

    user_id: str
    email: str
    given_name: str = ""
    picture: str = ""


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


class CookieSigner:
    """Minimal HMAC-SHA256 signer for the JSON session cookie."""

    def __init__(self, secret: str, max_age_seconds: int) -> None:
        self._key = hashlib.sha256(
            ("fitness-buddy-session:" + secret).encode()
        ).digest()
        self._max_age = max_age_seconds

    def _sign(self, payload: str) -> str:
        return _b64encode(
            hmac.new(self._key, payload.encode("ascii"), hashlib.sha256).digest()
        )

    def dumps(self, data: dict[str, Any]) -> str:
        """Serializes and signs ``data`` (an ``iat`` timestamp is added)."""
        payload = _b64encode(
            json.dumps(
                {**data, "iat": int(time.time())}, separators=(",", ":")
            ).encode()
        )
        return f"{payload}.{self._sign(payload)}"

    def loads(self, token: str | None) -> dict[str, Any] | None:
        """Returns the cookie data, or None if missing, tampered or expired."""
        if not token or "." not in token:
            return None
        payload, signature = token.rsplit(".", 1)
        if not hmac.compare_digest(signature, self._sign(payload)):
            return None
        try:
            data = json.loads(_b64decode(payload))
        except (ValueError, json.JSONDecodeError):
            return None
        if (
            not isinstance(data, dict)
            or time.time() - int(data.get("iat", 0)) > self._max_age
        ):
            return None
        return data


def is_local_request(request: Request) -> bool:
    """True when served on localhost (cookies cannot be Secure over plain HTTP)."""
    return (request.url.hostname or "") in ("localhost", "127.0.0.1", "testserver")


def read_session(request: Request) -> dict[str, Any]:
    """Returns the verified cookie session (empty dict when absent/invalid)."""
    signer: CookieSigner = request.app.state.signer
    return signer.loads(request.cookies.get(COOKIE_NAME)) or {}


def write_session(request: Request, response: Response, data: dict[str, Any]) -> None:
    """Signs ``data`` into the session cookie on ``response``."""
    settings: WebSettings = request.app.state.settings
    signer: CookieSigner = request.app.state.signer
    response.set_cookie(
        COOKIE_NAME,
        signer.dumps(data),
        max_age=settings.session_max_age_seconds,
        httponly=True,
        secure=not is_local_request(request),
        samesite="lax",
        path="/",
    )


def clear_session(request: Request, response: Response) -> None:
    """Deletes the session cookie."""
    response.delete_cookie(
        COOKIE_NAME,
        path="/",
        secure=not is_local_request(request),
        httponly=True,
        samesite="lax",
    )


def current_user(request: Request) -> CurrentUser:
    """FastAPI dependency: the signed-in user, or HTTP 401.

    The development bypass (``DEV_AUTH_BYPASS=true``) only applies when the
    app is not running on Cloud Run (``K_SERVICE`` unset).
    """
    settings: WebSettings = request.app.state.settings
    if settings.dev_auth_bypass:
        return CurrentUser(user_id=DEV_USER_ID, email=DEV_USER_EMAIL)
    session = read_session(request)
    if not session.get("sub"):
        raise HTTPException(status_code=401, detail="Sign in required.")
    return CurrentUser(
        user_id=str(session["sub"]),
        email=str(session.get("email", "")),
        given_name=str(session.get("given_name", "")),
        picture=str(session.get("picture", "")),
    )


def verify_google_credential(credential: str, settings: WebSettings) -> CurrentUser:
    """Verifies a Google ID token and enforces the e-mail allowlist.

    Args:
        credential: The ID token (JWT) returned by Google Identity Services.
        settings: Web settings with the OAuth client ID and allowlist.

    Returns:
        The verified user.

    Raises:
        HTTPException: 401 for invalid tokens, 403 for accounts not allowed.
    """
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    if not settings.google_client_id:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured.")
    try:
        claims = id_token.verify_oauth2_token(
            credential, google_requests.Request(), audience=settings.google_client_id
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=401, detail="Invalid Google credential."
        ) from exc
    email = str(claims.get("email", "")).lower()
    if not claims.get("email_verified") or not email:
        raise HTTPException(
            status_code=403, detail="Your Google e-mail address is not verified."
        )
    if email not in settings.allowed_emails:
        raise HTTPException(
            status_code=403, detail="This Google account is not on the allowlist."
        )
    picture = str(claims.get("picture") or "")
    return CurrentUser(
        user_id=str(claims["sub"]),
        email=email,
        given_name=str(claims.get("given_name") or "")[:60],
        # Only Google-hosted avatars are allowed by the CSP (img-src).
        picture=picture
        if picture.startswith("https://lh3.googleusercontent.com/")
        else "",
    )
