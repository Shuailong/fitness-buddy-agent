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

# ruff: noqa: RUF001
"""Per-exercise form guides: coverage, language hygiene, matching, sync."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from fitness_core.plans import load_exercise_library
from web import form_coach
from web.exercise_guides import (
    PATTERNS,
    WEB_MODULE_PATH,
    load_guide_book,
    load_guides,
    normalize_name,
    render_web_module,
    resolve_exercise_id,
)

STATIC_JS = Path(__file__).resolve().parents[2] / "web" / "static" / "js"
_CJK = re.compile(r"[\u4e00-\u9fff]")
_LATIN = re.compile(r"[A-Za-z]")

# Library muscle keys -> guide keys that count as covering them.
_COVERS = {
    "shoulders": {"front_delts", "side_delts", "rear_delts"},
    "core": {"core", "abs", "obliques"},
    "upper_back": {"upper_back", "rhomboids", "traps", "rear_delts"},
    "hips": {"hips", "hip_flexors", "glutes"},
    "spine": {"spine", "thoracic_spine"},
}


def _zh_en_pairs(guide):
    yield guide.names.zh, guide.names.en
    for field in ("tempo", "breathing", "safety", "easier", "harder", "camera_view"):
        loc = getattr(guide, field)
        yield loc.zh, loc.en
    for cue in guide.cues:
        yield cue.zh.title, cue.en.title
        yield cue.zh.text, cue.en.text
    for mistake in guide.mistakes:
        yield mistake.zh.bad, mistake.en.bad
        yield mistake.zh.fix, mistake.en.fix
    yield from zip(guide.checkpoints.zh, guide.checkpoints.en, strict=True)


def test_every_library_exercise_has_exactly_one_guide() -> None:
    library = load_exercise_library()
    guides = load_guides()
    assert set(guides) == set(library)
    assert len(load_guide_book().guides) == len(guides)  # no duplicates


def test_guides_use_known_patterns_and_muscles() -> None:
    book = load_guide_book()
    library = load_exercise_library()
    poses_src = (STATIC_JS / "exercise-poses.js").read_text(encoding="utf-8")
    animated = set(re.findall(r"^  (\w+)\(t\) \{", poses_src, re.M))
    assert set(PATTERNS) <= animated, set(PATTERNS) - animated
    for guide in book.guides:
        assert guide.pattern in PATTERNS, guide.id
        keys = guide.muscles.primary + guide.muscles.secondary
        assert set(keys) <= set(book.muscles), (guide.id, keys)
        if guide.motion == "rep":
            assert guide.phase_order, guide.id
        for muscle in library[guide.id].muscles:
            assert set(keys) & _COVERS.get(muscle, {muscle}), (guide.id, muscle)


def test_chinese_and_english_copy_do_not_mix() -> None:
    for guide in load_guides().values():
        for zh, en in _zh_en_pairs(guide):
            assert not _LATIN.search(zh.replace("RDL", "")), (guide.id, zh)
            assert not _CJK.search(en), (guide.id, en)
            assert zh.strip() and en.strip(), guide.id


def test_names_and_aliases_resolve_to_their_exercise() -> None:
    library = load_exercise_library()
    for guide in load_guides().values():
        for text in (
            guide.id,
            guide.names.en,
            guide.names.zh,
            library[guide.id].name,
            *guide.aliases,
        ):
            assert resolve_exercise_id(name=text) == guide.id, (text, guide.id)
    # Free-text variants from plans and logs.
    assert resolve_exercise_id(name="Push-Up") == "push_up"
    assert resolve_exercise_id(name="push up") == "push_up"
    assert resolve_exercise_id(name="Pull-Up") == "pull_up"
    assert resolve_exercise_id(name="Dead Bug") == "dead_bug"
    assert resolve_exercise_id(name="Leg Press") == "leg_press"
    assert resolve_exercise_id(name="Paused Goblet Squat") == "goblet_squat"
    assert resolve_exercise_id(name="哑铃高脚杯深蹲（暂停）") == "goblet_squat"
    assert resolve_exercise_id(name="杠铃罗马尼亚硬拉") == "dumbbell_romanian_deadlift"
    assert resolve_exercise_id(name="Incline Push-Up") == "incline_push_up"
    assert resolve_exercise_id(name="Side Plank") == "side_plank"
    # Unknown exercises are not forced onto a wrong guide.
    assert resolve_exercise_id(name="Front Squat") is None
    assert resolve_exercise_id(name="Face Pull") is None
    assert resolve_exercise_id("", "") is None


def test_normalize_name_rules() -> None:
    assert normalize_name("Push-Up") == "pushup"
    assert normalize_name("box_squat_to_bench") == "boxsquattobench"
    assert normalize_name("Box Squat to Bench (partial range)") == "boxsquattobench"
    assert normalize_name("  哑铃 卧推（平板） ") == "哑铃卧推"


def test_generated_web_module_is_in_sync() -> None:
    assert WEB_MODULE_PATH.read_text(encoding="utf-8") == render_web_module(), (
        "Run: uv run python scripts/build_exercise_guides.py"
    )


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_browser_name_matching_matches_python() -> None:
    src = (STATIC_JS / "exercises.js").read_text(encoding="utf-8")
    fn = re.search(
        r"export function normalizeExerciseName\(text\) \{.*?\n\}", src, re.S
    ).group(0)
    samples = [
        "Push-Up",
        "Box Squat to Bench (partial range)",
        "  哑铃 卧推（平板） ",
        "World's Greatest Stretch",
        "Ｐｕｓｈ　Ｕｐ",
        "Low-Impact Cardio Circuit (marching, step jacks)",
    ]
    script = (
        fn.replace("export ", "")
        + f"\nconsole.log(JSON.stringify({json.dumps(samples)}.map(normalizeExerciseName)));"
    )
    out = subprocess.run(
        ["node", "-e", script], capture_output=True, text=True, check=True
    ).stdout
    assert json.loads(out) == [normalize_name(s) for s in samples]


def test_form_coach_uses_the_exercise_guides() -> None:
    assert form_coach.resolve_archetype("standing_calf_raise") == "calf_raise"
    assert form_coach.resolve_archetype("dumbbell_biceps_curl") == "biceps_curl"
    assert (
        form_coach.resolve_archetype("", "Hanging Knee Raise") == "hanging_knee_raise"
    )
    assert form_coach.resolve_archetype("", "Front Squat") == "generic"
    brief = form_coach._exercise_brief("standing_calf_raise", "", True)
    guide = load_guides()["standing_calf_raise"]
    assert brief["name"] == guide.names.zh
    assert guide.checkpoints.zh[0] in brief["checks"]
    assert guide.camera_view.zh.rstrip("。") == brief["view"]
    en = form_coach._exercise_brief("", "Mystery Move", False)
    assert en["name"] == "Mystery Move" and en["checks"] == ""
