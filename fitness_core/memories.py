"""Explicit coach memory: durable, user-visible facts kept across conversations.

Complements the implicit Memory Bank recall with a small, structured list the
user can see and edit (Settings → Coach Memory). The coach writes entries with
``remember_user_fact``; every model call sees the list via a system
instruction, so recall does not depend on semantic search.
"""

from __future__ import annotations

import re
from typing import Any

from fitness_core.models import MemoryCategory, UserMemory, utc_now
from fitness_core.repository import FitnessRepository, new_entry_id

MAX_MEMORIES = 40
MAX_PROMPT_CHARS = 2400
CATEGORIES: tuple[str, ...] = (
    "preference",
    "goal",
    "schedule",
    "training",
    "nutrition",
    "health",
    "other",
)


def _norm(text: str) -> str:
    return re.sub(r"[\W_]+", "", text).lower()  # ignore spacing/punctuation


def clean_memory_text(text: str) -> str:
    """Collapses whitespace and trims to the stored length limit."""
    return re.sub(r"\s+", " ", str(text or "")).strip()[:240]


async def remember(
    repo: FitnessRepository,
    user_id: str,
    text: str,
    *,
    category: str = "other",
    source: str = "coach",
    replaces_memory_id: str | None = None,
) -> dict[str, Any]:
    """Adds (or replaces) a memory. Returns ``{"status": ..., "memory": {...}}``."""
    clean = clean_memory_text(text)
    if not clean:
        return {"status": "error", "error_message": "Memory text is empty."}
    cat: MemoryCategory = category if category in CATEGORIES else "other"  # type: ignore[assignment]
    existing = await repo.list_memories(user_id)
    if replaces_memory_id:
        old = next((m for m in existing if m.memory_id == replaces_memory_id), None)
        if old is None:
            return {
                "status": "error",
                "error_message": f"No memory with id {replaces_memory_id}.",
            }
        updated = old.model_copy(
            update={"text": clean, "category": cat, "updated_at": utc_now()}
        )
        await repo.save_memory(updated)
        return {"status": "updated", "memory": updated.model_dump(mode="json")}
    key = _norm(clean)
    for m in existing:
        if _norm(m.text) == key:
            return {"status": "duplicate", "memory": m.model_dump(mode="json")}
    if len(existing) >= MAX_MEMORIES:
        return {
            "status": "error",
            "error_message": f"Memory is full ({MAX_MEMORIES} items).",
            "recovery_hint": "Replace an outdated memory (replaces_memory_id) or forget one first.",
        }
    memory = UserMemory(
        memory_id=new_entry_id(),
        user_id=user_id,
        text=clean,
        category=cat,
        source="user" if source == "user" else "coach",
    )
    await repo.save_memory(memory)
    return {"status": "saved", "memory": memory.model_dump(mode="json")}


def memories_prompt(memories: list[UserMemory]) -> str:
    """Formats memories as a compact system instruction block ('' when empty)."""
    if not memories:
        return ""
    lines = [
        "# What you remember about this user (Coach Memory, user-visible)",
        "Durable facts from earlier conversations, shared by every coach persona.",
        "Use them to personalize; prefer what the user says today if it conflicts,",
        "and then update the memory (remember_user_fact with replaces_memory_id).",
    ]
    used = sum(len(line) for line in lines)
    for m in memories:
        line = f"- [{m.memory_id}] ({m.category}) {m.text}"
        if used + len(line) > MAX_PROMPT_CHARS:
            break
        lines.append(line)
        used += len(line)
    return "\n".join(lines)
