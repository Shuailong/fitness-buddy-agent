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

"""PII redaction before logs and long-term memory are written (NFR-B4, SR-8).

Two layers:

1. A fast, always-on regex scrubber (emails, phone numbers, card numbers,
   national ID numbers, IP addresses).
2. Cloud Sensitive Data Protection (DLP) ``deidentify_content`` when
   ``DLP_ENABLED=true``, which also catches names, street addresses and dates of
   birth. If DLP fails, the regex result is used (fail safe, never fail open to
   raw text).
"""

import logging
import re

from app.config import SETTINGS

logger = logging.getLogger(__name__)

_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("EMAIL_ADDRESS", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")),
    ("CREDIT_CARD_NUMBER", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    ("CHINA_RESIDENT_ID_NUMBER", re.compile(r"\b\d{17}[\dXx]\b")),
    (
        "PHONE_NUMBER",
        re.compile(
            r"(?<!\w)(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,4}\)?[ -]?)?\d{3,4}[ -]?\d{4}(?!\w)"
        ),
    ),
    ("IP_ADDRESS", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
]

DLP_INFO_TYPES = [
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "PERSON_NAME",
    "STREET_ADDRESS",
    "CREDIT_CARD_NUMBER",
    "CHINA_RESIDENT_ID_NUMBER",
    "IP_ADDRESS",
    "DATE_OF_BIRTH",
]

_dlp_client = None


def redact_text(text: str) -> str:
    """Scrubs common PII patterns with regexes (always on, synchronous).

    Args:
        text: Free text that may contain PII.

    Returns:
        The text with matches replaced by ``[INFO_TYPE]`` placeholders.
    """
    if not text:
        return text
    for info_type, pattern in _PATTERNS:
        text = pattern.sub(f"[{info_type}]", text)
    return text


def _get_dlp_client():
    global _dlp_client
    if _dlp_client is None:
        from google.cloud import dlp_v2

        _dlp_client = dlp_v2.DlpServiceAsyncClient()
    return _dlp_client


async def redact_text_async(text: str) -> str:
    """Scrubs PII with regexes, then Cloud DLP when enabled.

    Args:
        text: Free text that may contain PII.

    Returns:
        Redacted text. On any DLP error, the regex-redacted text is returned.
    """
    scrubbed = redact_text(text)
    if not scrubbed or not SETTINGS.dlp_enabled or not SETTINGS.project_id:
        return scrubbed
    try:
        client = _get_dlp_client()
        response = await client.deidentify_content(
            request={
                "parent": f"projects/{SETTINGS.project_id}/locations/{SETTINGS.dlp_location}",
                "inspect_config": {"info_types": [{"name": n} for n in DLP_INFO_TYPES]},
                "deidentify_config": {
                    "info_type_transformations": {
                        "transformations": [
                            {
                                "primitive_transformation": {
                                    "replace_with_info_type_config": {}
                                }
                            }
                        ]
                    }
                },
                "item": {"value": scrubbed},
            },
            timeout=5.0,
        )
        return response.item.value
    except Exception as exc:
        logger.warning(
            "DLP redaction failed; using regex redaction only: %s", type(exc).__name__
        )
        return scrubbed
