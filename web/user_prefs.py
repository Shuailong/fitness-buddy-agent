"""Per-user app preferences synced across devices (e.g. the selected coach persona).

Stored at ``users/{uid}/meta/preferences`` in Firestore so they are included in
the account export and removed by account deletion; the in-memory repository
keeps them in a dict on the repository object.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from web.form_coach import COACH_PERSONAS

DEFAULT_PERSONA = "iron_leo"


def _mem(repo: Any) -> dict[str, dict[str, Any]]:
    prefs = getattr(repo, "user_prefs", None)
    if prefs is None:
        prefs = {}
        repo.user_prefs = prefs
    return prefs


def _doc(repo: Any, user_id: str):
    db = getattr(repo, "_db", None)
    if db is None:
        return None
    return (
        db.collection("users")
        .document(user_id)
        .collection("meta")
        .document("preferences")
    )


def normalize_persona(value: str | None) -> str | None:
    """Returns a known persona ID or None."""
    pid = str(value or "").strip().lower()
    return pid if pid in COACH_PERSONAS else None


async def get_user_prefs(repo: Any, user_id: str) -> dict[str, Any]:
    """Returns ``{"coach_persona": str | None, "updated_at": str | None}``."""
    default = {"coach_persona": None, "updated_at": None}
    if not user_id:
        return default
    cache = _mem(repo)
    if user_id in cache:
        return {**default, **cache[user_id]}
    doc = _doc(repo, user_id)
    if doc is not None:
        try:
            snap = await doc.get()
            if snap.exists:
                data = snap.to_dict() or {}
                record = {
                    "coach_persona": normalize_persona(data.get("coach_persona")),
                    "updated_at": data.get("updated_at"),
                }
                cache[user_id] = record
                return record
        except Exception:
            pass
    return default


async def set_user_prefs(
    repo: Any, user_id: str, *, coach_persona: str | None = None
) -> dict[str, Any]:
    """Updates the given preference fields and returns the stored record."""
    current = await get_user_prefs(repo, user_id)
    record = dict(current)
    persona = normalize_persona(coach_persona)
    if persona:
        record["coach_persona"] = persona
    record["updated_at"] = datetime.now(UTC).isoformat()
    _mem(repo)[user_id] = record
    doc = _doc(repo, user_id)
    if doc is not None:
        try:
            await doc.set(record, merge=True)
        except Exception:
            pass
    return record


def forget_user_prefs(repo: Any, user_id: str) -> None:
    """Drops cached preferences (after account deletion)."""
    _mem(repo).pop(user_id, None)
