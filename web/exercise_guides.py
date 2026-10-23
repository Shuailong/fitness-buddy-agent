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

# ruff: noqa: RUF001, RUF002
"""Per-exercise form guides (cues, mistakes, muscles, camera view).

The single source of truth is ``web/data/exercise_guides.json`` (one curated entry
per exercise in the library). The web app ships a generated copy as a JS module
(``scripts/build_exercise_guides.py``) and the live form coach reads it here, so
the guide a user reads and the checks the camera coach applies always agree.
"""

from __future__ import annotations

import functools
import json
import re
import unicodedata
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

_GUIDES_PATH = Path(__file__).parent / "data" / "exercise_guides.json"

PATTERNS: tuple[str, ...] = (
    "squat",
    "box_squat",
    "leg_press",
    "rdl",
    "deadlift",
    "swing",
    "calf_raise",
    "bridge",
    "hip_thrust",
    "lunge",
    "step_up",
    "leg_curl",
    "push_up",
    "incline_push_up",
    "bench_press",
    "floor_press",
    "overhead_press",
    "lateral_raise",
    "overhead_triceps",
    "biceps_curl",
    "pull_apart",
    "pull_up",
    "hang",
    "lat_pulldown",
    "bent_row",
    "chest_supported_row",
    "seated_row",
    "standing_row",
    "hanging_knee_raise",
    "plank",
    "side_plank",
    "dead_bug",
    "bird_dog",
    "walk",
    "incline_walk",
    "run",
    "bike",
    "rowing_machine",
    "jump_rope",
    "march",
    "hip_flexor_stretch",
    "cat_cow",
    "worlds_greatest_stretch",
)


class Localized(BaseModel):
    zh: str = Field(min_length=1)
    en: str = Field(min_length=1)


class _CueText(BaseModel):
    title: str = Field(min_length=1)
    text: str = Field(min_length=1)


class Cue(BaseModel):
    zh: _CueText
    en: _CueText


class _MistakeText(BaseModel):
    bad: str = Field(min_length=1)
    fix: str = Field(min_length=1)


class Mistake(BaseModel):
    zh: _MistakeText
    en: _MistakeText


class Muscles(BaseModel):
    primary: list[str] = Field(min_length=1, max_length=3)
    secondary: list[str] = Field(default_factory=list, max_length=3)


class Checkpoints(BaseModel):
    zh: list[str] = Field(min_length=3, max_length=3)
    en: list[str] = Field(min_length=3, max_length=3)


class ExerciseGuide(BaseModel):
    """A curated, bilingual form guide for one library exercise."""

    id: str
    names: Localized
    aliases: list[str] = Field(default_factory=list)
    pattern: str
    motion: Literal["rep", "hold", "cyclic", "stretch"]
    phase_order: Literal["lower_first", "lift_first"] | None = None
    muscles: Muscles
    tempo: Localized
    breathing: Localized
    cues: list[Cue] = Field(min_length=3, max_length=3)
    mistakes: list[Mistake] = Field(min_length=2, max_length=3)
    safety: Localized
    easier: Localized
    harder: Localized
    camera_view: Localized
    checkpoints: Checkpoints
    video_query: str = Field(min_length=3)


class GuideBook(BaseModel):
    version: int
    muscles: dict[str, Localized]
    guides: list[ExerciseGuide]


_PAREN = re.compile(r"[(（\[【].*?[)）\]】]")
_NON_WORD = re.compile(r"[^0-9a-z\u4e00-\u9fff]+")


def normalize_name(text: str) -> str:
    """Normalizes an exercise name for matching (shared rule with the web app).

    NFKC + lowercase, drops bracketed qualifiers ("(partial range)", "（暂停）"),
    then keeps only ASCII letters/digits and CJK ideographs, so "Push-Up",
    "push up" and "push_up" all become "pushup".
    """
    s = unicodedata.normalize("NFKC", text or "").lower()
    s = _PAREN.sub(" ", s)
    return _NON_WORD.sub("", s)


@functools.cache
def load_guide_book() -> GuideBook:
    raw = json.loads(_GUIDES_PATH.read_text(encoding="utf-8"))
    return GuideBook.model_validate(raw)


@functools.cache
def load_guides() -> dict[str, ExerciseGuide]:
    return {g.id: g for g in load_guide_book().guides}


@functools.cache
def name_index() -> dict[str, str]:
    """Normalized id/name/alias -> exercise id (ids win over aliases)."""
    index: dict[str, str] = {}
    for g in load_guides().values():
        for key in (g.names.en, g.names.zh, *g.aliases):
            norm = normalize_name(key)
            if norm:
                index.setdefault(norm, g.id)
    for g in load_guides().values():
        index[normalize_name(g.id)] = g.id
    return index


def _min_contained_len(key: str) -> int:
    # CJK names are dense: two ideographs ("提踵") are already specific.
    return 2 if re.search(r"[\u4e00-\u9fff]", key) else 5


def resolve_exercise_id(exercise_id: str = "", name: str = "") -> str | None:
    """Maps a library id or free-text name to a guide id (None = unknown).

    1. exact library id; 2. exact normalized name/alias; 3. the longest known
    name contained in the text ("Paused Goblet Squat" -> goblet_squat).
    """
    guides = load_guides()
    eid = (exercise_id or "").strip().lower()
    if eid in guides:
        return eid
    index = name_index()
    for probe in (eid, name):
        norm = normalize_name(probe)
        if norm and norm in index:
            return index[norm]
    best: tuple[int, str] | None = None
    for probe in (name, eid):
        norm = normalize_name(probe)
        if not norm:
            continue
        for key, gid in index.items():
            if len(key) >= _min_contained_len(key) and key in norm:
                if best is None or len(key) > best[0]:
                    best = (len(key), gid)
        if best:
            return best[1]
    return None


def get_guide(exercise_id: str = "", name: str = "") -> ExerciseGuide | None:
    gid = resolve_exercise_id(exercise_id, name)
    return load_guides().get(gid) if gid else None


def guide_book_for_web() -> dict[str, Any]:
    """The payload shipped to the browser (guides keyed by id + name index)."""
    book = load_guide_book()
    return {
        "version": book.version,
        "muscles": {k: v.model_dump() for k, v in book.muscles.items()},
        "guides": {g.id: g.model_dump() for g in book.guides},
        "index": dict(sorted(name_index().items())),
    }


WEB_MODULE_PATH = Path(__file__).parent / "static" / "js" / "exercise-guides-data.js"


def render_web_module() -> str:
    """Source of the generated browser module (kept in sync by a unit test)."""
    payload = json.dumps(
        guide_book_for_web(), ensure_ascii=False, separators=(",", ":")
    )
    return (
        "// GENERATED from web/data/exercise_guides.json - do not edit by hand.\n"
        "// Regenerate: uv run python scripts/build_exercise_guides.py\n"
        f"export const GUIDE_BOOK = {payload};\n"
    )
