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

# ruff: noqa: RUF001 (Chinese UI copy)
"""Localized user-facing error messages from the web API.

The browser sends its UI language in the ``X-UI-Lang`` header; error details
written in English in the code are translated here, so a Chinese UI never
shows English errors. Unknown messages fall back to the English text.
"""

from __future__ import annotations

import re

_ZH: dict[str, str] = {
    "Sign in required.": "请先登录。",
    "The demo has ended. Sign in to keep going.": "体验已结束，登录后可以继续使用。",
    "Invalid Google credential.": "Google 登录凭证无效，请重试。",
    "Your Google e-mail address is not verified.": "你的 Google 邮箱尚未验证。",
    "Google sign-in is not configured.": "Google 登录暂不可用。",
    "This Google account is not on the allowlist.": "这个 Google 账号还不在内测名单中。",
    "No active conversation. Call POST /api/session first.": "对话还没准备好，请刷新页面后重试。",
    "Demo mode is off.": "体验模式已关闭。",
    "Conversation not found.": "找不到这段对话，请刷新页面。",
    "Voice messages are limited to about 2 minutes.": "语音最长约 2 分钟。",
    "Unsupported audio format.": "不支持这种音频格式。",
    "Could not transcribe that recording.": "这段录音没能转成文字，请重试。",
    "Send a message or a photo.": "请输入消息或选择照片。",
    "Photos are limited to 6 MB.": "照片不能超过 6 MB。",
    "Please upload a JPEG, PNG or WebP photo.": "请上传 JPEG、PNG 或 WebP 格式的照片。",
    "Frame is too large.": "画面太大，请重试。",
    "Please upload a JPEG, PNG or WebP frame.": "画面格式不支持。",
    "Live form coaching needs a signed-in account.": "实时摄像指导需要登录后使用。",
    "Forbidden": "没有权限。",
    "This request is no longer waiting for a decision.": "这个请求已经处理过了。",
    "Meal photo not found.": "找不到这张餐食照片。",
    "Add a comment or pick a category.": "请填写反馈内容或选择一个类别。",
    "Admin role required to access the management console.": "需要管理员权限。",
    "Please enter a valid e-mail address.": "请输入有效的邮箱地址。",
    "Memory not found.": "找不到这条记忆。",
    "Reminders need a signed-in account.": "登录后可以开启提醒。",
    "Reminders are not configured.": "提醒功能暂不可用。",
    "Not subscribed on this device.": "这台设备还没有开启提醒。",
    "The coach is unavailable right now.": "教练暂时无法连接，请稍后再试。",
    "The coach is unavailable right now. Please try again.": "教练暂时无法连接，请稍后再试。",
    "The coach hit an error. Please try again.": "教练出了点问题，请重试。",
    "Loading older messages took too long.": "加载更早的聊天超时了，请重试。",
    "Loading the conversation took too long.": "加载对话超时了，请重试。",
    "Loading your progress took too long.": "加载数据超时了，请重试。",
    "Could not load your progress right now.": "暂时无法加载你的数据。",
    "Too many requests. Please slow down and try again shortly.": "操作太频繁了，请稍后再试。",
    "Demo is busy right now. Please sign in or try again later.": "体验人数较多，请稍后再试或直接登录。",
    "The demo is busy right now. Sign in to keep chatting.": "体验人数较多，登录后可以继续聊天。",
    "Primary admin accounts configured in ADMIN_EMAILS cannot be revoked.": "主管理员账号不能被移除。",
}
_ZH_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"^Messages are limited to (\d+) characters\.$"),
        "消息不能超过 {0} 个字。",
    ),
    (
        re.compile(r"^Agent server returned HTTP (\d+)\.$"),
        "教练暂时无法连接，请稍后再试。",
    ),
]


def ui_lang(value: str | None) -> str:
    return "zh" if str(value or "").lower().startswith("zh") else "en"


def localize(message: str, lang: str | None) -> str:
    """Translates a known English API message for the UI language."""
    if ui_lang(lang) != "zh" or not isinstance(message, str):
        return message
    if message in _ZH:
        return _ZH[message]
    for pattern, template in _ZH_PATTERNS:
        m = pattern.match(message)
        if m:
            return template.format(*m.groups())
    return message
