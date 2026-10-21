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

"""Missing-translation checks for the web UI (web/static/js/i18n.js).

* every language has the same keys, with the same {placeholders};
* every key the UI uses (t("..."), translate(lang, "..."), data-i18n) exists;
* no new inline `isZh ? "中文" : "English"` strings: UI text belongs in i18n.js.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

STATIC = Path(__file__).resolve().parents[2] / "web" / "static"
I18N = STATIC / "js" / "i18n.js"
UI_FILES = [
    STATIC / "app.js",
    *sorted((STATIC / "js").glob("*.js")),
    *sorted(STATIC.glob("*.html")),
]
# Files whose bilingual ternaries pick between content fields (data, not UI
# strings), or that are standalone pages with their own copy tables.
TERNARY_ALLOWED = {"i18n.js", "theme-boot.js", "install.js", "admin.js", "changelog.js"}
_STR = r'(?:"(?:[^"\\\n]|\\.)*"|\'(?:[^\'\\\n]|\\.)*\'|`(?:[^`\\]|\\.)*`)'
_INLINE = re.compile(
    r'(?:isZh|getLang\(\)\s*===\s*"zh"|lang\s*===\s*"zh")\s*\?\s*'
    + _STR
    + r"\s*:\s*"
    + _STR
)


def _dict(name: str) -> dict[str, str]:
    src = I18N.read_text(encoding="utf-8")
    start = src.index(f"\nconst {name} = {{")
    end = src.index("\n};", start)
    return {
        k: json.loads(v)
        for k, v in re.findall(
            r'^\s+"([^"]+)":\s*("(?:[^"\\]|\\.)*"),?\s*$', src[start:end], re.M
        )
    }


def _placeholders(text: str) -> set[str]:
    return set(re.findall(r"\{(\w+)\}", text))


def test_all_languages_have_the_same_keys_and_placeholders() -> None:
    en, zh = _dict("en"), _dict("zh")
    assert len(en) > 500
    assert sorted(set(en) - set(zh)) == [], "missing in zh"
    assert sorted(set(zh) - set(en)) == [], "missing in en"
    mismatched = [k for k in en if _placeholders(en[k]) != _placeholders(zh[k])]
    assert mismatched == [], f"placeholder mismatch: {mismatched[:10]}"
    # Word-order fragments (e.g. the landing title) may be empty in one language.
    may_be_empty = {"lp.title.pre", "lp.title.post"}
    empty = [
        k
        for k in en
        if k not in may_be_empty and (not en[k].strip() or not zh[k].strip())
    ]
    assert empty == [], f"empty translations: {empty[:10]}"


def test_every_key_used_by_the_ui_exists() -> None:
    en = _dict("en")
    used: dict[str, str] = {}
    patterns = [
        r'\bt\(\s*"([\w.-]+)"',
        r'\btranslate\(\s*[\w.]+\s*,\s*"([\w.-]+)"',
        r'data-i18n="([\w.-]+)"',
        r'data-i18n-attr="[\w-]+:([\w.-]+)"',
    ]
    for path in UI_FILES:
        src = path.read_text(encoding="utf-8")
        for pat in patterns:
            for key in re.findall(pat, src):
                used.setdefault(key, path.name)
    missing = {k: f for k, f in used.items() if k not in en}
    assert missing == {}, f"keys used but not translated: {missing}"


def test_no_inline_bilingual_ui_strings() -> None:
    offenders = []
    for path in UI_FILES:
        if path.suffix != ".js" or path.name in TERNARY_ALLOWED:
            continue
        for m in _INLINE.finditer(path.read_text(encoding="utf-8")):
            offenders.append(f"{path.name}: {m.group(0)[:80]}")
    assert offenders == [], (
        "Move these strings into web/static/js/i18n.js and use t()/translate():\n"
        + "\n".join(offenders)
    )
