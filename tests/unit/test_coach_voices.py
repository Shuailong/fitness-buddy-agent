"""Guards the coach voice mapping so read-aloud never drifts to a generic voice."""
# ruff: noqa: RUF001

import re

from web.form_coach import (
    _EDGE_PERSONA_VOICES,
    COACH_CLOUD_VOICES,
    _chirp_safe,
)

COACHES = {"iron_leo", "warm_maya", "science_dr_chen"}


def test_every_coach_has_primary_and_fallback_per_language() -> None:
    assert set(COACH_CLOUD_VOICES) == COACHES
    for coach, langs in COACH_CLOUD_VOICES.items():
        assert set(langs) == {"zh", "en"}, coach
        for lang, (primary, fallback) in langs.items():
            prefix = "cmn-CN-" if lang == "zh" else "en-US-"
            assert primary.startswith(prefix) and fallback.startswith(prefix)
            assert "Chirp3-HD" in primary
            assert "Wavenet" in fallback or "Neural2" in fallback


def test_coaches_have_distinct_voices() -> None:
    for lang in ("zh", "en"):
        primaries = {v[lang][0] for v in COACH_CLOUD_VOICES.values()}
        fallbacks = {v[lang][1] for v in COACH_CLOUD_VOICES.values()}
        assert len(primaries) == len(fallbacks) == len(COACHES)


def test_edge_voices_cover_every_coach() -> None:
    assert COACHES <= set(_EDGE_PERSONA_VOICES)


def test_chirp_safe_puts_each_sentence_on_its_own_line() -> None:
    text = "好的，今天晚饭吃鸡胸肉。再配一碗糙米饭！明天见？"
    assert _chirp_safe(text).split("\n") == [
        "好的，今天晚饭吃鸡胸肉。",
        "再配一碗糙米饭！",
        "明天见？",
    ]


def test_chirp_safe_breaks_long_sentences_without_losing_words() -> None:
    text = "深蹲的时候膝盖要和脚尖方向保持一致，下蹲到大腿和地面平行就可以了，核心收紧，背部挺直，起身的时候用脚跟发力。"
    out = _chirp_safe(text, 20)
    assert all(len(line) <= 21 for line in out.split("\n"))
    strip = lambda s: re.sub(r"[，。\n]", "", s)  # noqa: E731
    assert strip(out) == strip(text)
