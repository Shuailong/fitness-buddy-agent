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

"""Real-time AI exercise form analysis, neural coach TTS & persona definitions.

Key capabilities:
1. Strict evidence-gated multimodal vision analysis (``gemini-3.8-flash`` /
   ``gemini-2.5-flash``): verifies ``person_visible``, ``required_joints_visible``,
   and ``performing_exercise`` before scoring. Refuses to fabricate scores or
   reps when the camera view is incomplete or the user is not performing the
   movement.
2. Natural neural voice synthesis (``synthesize_coach_speech``): generates
   expressive, human-like coach speech audio via Gemini 2.5 Native Audio TTS
   (with distinct prebuilt voices per persona) and neural MP3 fallback, cached
   in memory for low-latency playback.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import time
import wave
from collections import OrderedDict
from typing import Any

import httpx

from web.exercise_guides import get_guide
from web.observability import log_event

_VISION_MODELS: tuple[str, ...] = (
    os.environ.get("FORM_COACH_MODEL", "gemini-3.8-flash"),
    "gemini-2.5-flash",
    "gemini-3.5-flash-lite",
)
_TTS_MODELS: tuple[str, ...] = (
    os.environ.get("FORM_COACH_TTS_MODEL", "gemini-2.5-flash-preview-tts"),
    "gemini-2.5-flash-tts",
    "gemini-2.5-pro-preview-tts",
)
_DEFAULT_GEMINI_PROJECT = "adk-demo-2-l300"
_VISION_TIMEOUT_S = 8.0
_TTS_TIMEOUT_S = 5.5
_INTERNAL_HEADER = "fitness-buddy-internal-v1"

# In-memory LRU cache for synthesized TTS audio: (persona, lang, text) -> dict
_TTS_CACHE: OrderedDict[tuple[str, str, str], dict[str, str]] = OrderedDict()
_TTS_CACHE_MAX = 96

COACH_PERSONAS: dict[str, dict[str, str]] = {
    "iron_leo": {
        "id": "iron_leo",
        "name_zh": "雷奥教练 · Coach Leo",
        "name_en": "Coach Leo",
        "gender": "male",
        "gemini_voice": "Fenrir",
        "tts_style_zh": (
            "请用充满活力、真诚自然、像真人男私教在健身房现场带练的口吻说出下面这句话，"
            "语气干脆有感染力，有真人的呼吸感与节奏感，绝对不要像机器播音员："
        ),
        "tts_style_en": (
            "Say this in a natural, warm-blooded, energetic male strength coach tone "
            "with real human cadence and encouragement:"
        ),
        "prompt_zh": (
            "你现在的身份是【雷奥教练 (Coach Leo)】，男，硬核热血力量与体能主教练。"
            "你的说话风格：像真人在身边带练一样自然口语化、干脆利落、热血真诚，常称呼用户为“搭档”，"
            "严格把控动作质量与安全底线，绝不敷衍夸奖。"
        ),
        "prompt_en": (
            "You are Coach Leo (male), a high-energy, no-nonsense strength & conditioning coach. "
            "Speak naturally like a real coach standing beside the athlete—direct, motivating, and strict on form."
        ),
    },
    "warm_maya": {
        "id": "warm_maya",
        "name_zh": "林悦教练 · Coach Maya",
        "name_en": "Coach Maya",
        "gender": "female",
        "gemini_voice": "Aoede",
        "tts_style_zh": (
            "请用温暖亲切、自然柔和、带着笑意的真人女教练口吻说出下面这句话，"
            "像好朋友在身边贴心指导一样自然流畅，绝对不要生硬机械："
        ),
        "tts_style_en": (
            "Say this in a warm, gentle, smiling female wellness coach voice, "
            "like a supportive friend guiding you in person:"
        ),
        "prompt_zh": (
            "你现在的身份是【林悦教练 (Coach Maya)】，女，温柔共情型身心健康与运动营养教练。"
            "你的说话风格：温暖亲切、完全口语化、细腻耐心，像真人女私教在身边轻声细语地指导，"
            "同时对动作安全和镜头取景保持认真负责，看不清时会温柔提醒用户调整镜头。"
        ),
        "prompt_en": (
            "You are Coach Maya (female), a warm, empathetic holistic fitness & nutrition coach. "
            "Speak naturally and gently like a caring friend, while still checking posture honestly and carefully."
        ),
    },
    "science_dr_chen": {
        "id": "science_dr_chen",
        "name_zh": "陈博士 · Dr. Alex Chen",
        "name_en": "Dr. Alex Chen",
        "gender": "neutral",
        "gemini_voice": "Charon",
        "tts_style_zh": (
            "请用温和沉稳、自然清晰、像运动科学专家面对面聊天交流的口吻说出下面这句话，"
            "语速适中、重点突出，不要像背诵课文一样生硬："
        ),
        "tts_style_en": (
            "Say this in a calm, articulate, conversational sports scientist voice, "
            "explaining clearly and naturally:"
        ),
        "prompt_zh": (
            "你现在的身份是【陈博士 (Dr. Alex Chen)】，运动生理学与生物力学专家。"
            "你的说话风格：温和沉稳、逻辑严密但口语自然，用通俗易懂的话点出关节力臂与发力细节，"
            "科学严谨，没有足够视觉证据时绝不盲目下结论。"
        ),
        "prompt_en": (
            "You are Dr. Alex Chen, an evidence-based sports physiologist and biomechanics specialist. "
            "Speak with calm, conversational precision, and never guess when visual evidence is incomplete."
        ),
    },
}


def build_persona_prefix(persona_id: str | None, lang: str = "zh") -> str:
    """Returns a system-style persona instruction prefix for chat turns, or empty string."""
    if not persona_id:
        return ""
    spec = COACH_PERSONAS.get(str(persona_id).strip().lower())
    if not spec:
        return ""
    is_zh = str(lang or "zh").lower().startswith("zh")
    directive = spec["prompt_zh"] if is_zh else spec["prompt_en"]
    return f"[Coach Persona Directive: {directive}]\n\n"


_DIRECTIVE_OPEN = "[Coach Persona Directive: "


def persona_from_directive(text: str | None) -> str | None:
    """Returns the persona ID whose directive prefixes ``text`` (chat history), or None."""
    if not text or not text.startswith(_DIRECTIVE_OPEN):
        return None
    end = text.find("]\n\n")
    directive = text[len(_DIRECTIVE_OPEN) : end if end != -1 else None]
    for pid, spec in COACH_PERSONAS.items():
        if directive in (spec.get("prompt_zh"), spec.get("prompt_en")):
            return pid
    return None


# Movement pattern + camera requirements come from the per-exercise guides
# (web/data/exercise_guides.json), the same data the in-app form guide shows.
_GENERIC_VIEW = {
    "zh": "必须清晰看到执行该训练动作所需的全身或主要关节部位，且用户正在实际做该动作",
    "en": "The whole body (or every joint the exercise moves) must be clearly visible while the user is actually doing the exercise",
}


def resolve_archetype(exercise_id: str, exercise_name: str = "") -> str:
    """Maps an exercise ID or free-text name to its movement pattern."""
    guide = get_guide(exercise_id, exercise_name)
    return guide.pattern if guide else "generic"


def _exercise_brief(
    exercise_id: str, exercise_name: str, is_zh: bool
) -> dict[str, str]:
    """Name, camera requirement and checkpoints for the vision prompt."""
    lang = "zh" if is_zh else "en"
    guide = get_guide(exercise_id, exercise_name)
    if not guide:
        return {
            "name": exercise_name or exercise_id,
            "view": _GENERIC_VIEW[lang],
            "checks": "",
            "mistakes": "",
        }
    checks = getattr(guide.checkpoints, lang)
    mistakes = [getattr(m, lang).bad for m in guide.mistakes]
    sep = "；" if is_zh else "; "
    return {
        "name": getattr(guide.names, lang),
        "view": getattr(guide.camera_view, lang).rstrip("。."),
        "checks": sep.join(checks),
        "mistakes": sep.join(mistakes),
    }


_CUES_ZH: dict[str, list[dict[str, Any]]] = {
    "squat": [
        {
            "status": "good",
            "score": 91,
            "phase_detected": "eccentric",
            "voice_cue": "下蹲节奏很稳，吸气把气沉到腹腔，重心踩稳脚掌中间。",
            "voice_cue_iron_leo": "好节奏！核心给我绷紧，慢慢往下坐，全脚掌死死抓地！",
            "voice_cue_warm_maya": "节奏特别稳呢，吸气慢慢往下坐，感受臀部和大腿一起发力～",
            "voice_cue_science_dr_chen": "离心下蹲角速度很均匀，足底压力保持在中足，继续维持脊柱中立。",
            "checks": [
                {"label": "脊柱中立", "ok": True, "detail": "背部挺直，核心绷紧稳定"},
                {"label": "膝盖轨迹", "ok": True, "detail": "膝盖顺着脚尖方向自然推进"},
                {"label": "下蹲控制", "ok": True, "detail": "离心下放节奏均匀受控"},
            ],
            "rep_increment": 0,
        },
        {
            "status": "adjust",
            "score": 82,
            "phase_detected": "bottom",
            "voice_cue": "底部注意膝盖别往里扣，主动往外推开，呼气蹬地站起来！",
            "voice_cue_iron_leo": "膝盖往外顶开，千万别内扣！脚后跟发力，直接蹬起来！",
            "voice_cue_warm_maya": "留意一下两边膝盖哦，往脚尖外侧轻轻打开一点，呼气稳稳站起来～",
            "voice_cue_science_dr_chen": "底部出现轻微膝内扣，请主动激活臀中肌把膝盖向外推，协同蹬伸起身。",
            "checks": [
                {"label": "脊柱中立", "ok": True, "detail": "胸口保持打开不塌腰"},
                {
                    "label": "膝盖轨迹",
                    "ok": False,
                    "detail": "底部有轻微内扣趋势，需主动外推膝盖",
                },
                {
                    "label": "下蹲深度",
                    "ok": True,
                    "detail": "大腿达到水平线，臀腿充分拉伸",
                },
            ],
            "rep_increment": 1,
        },
        {
            "status": "good",
            "score": 93,
            "phase_detected": "concentric",
            "voice_cue": "这一下发力很流畅！站直时轻轻夹紧臀部，膝盖留一点微屈别锁死。",
            "voice_cue_iron_leo": "干得漂亮！这一发干净利落，顶峰夹紧臀部，保持住再来一个！",
            "voice_cue_warm_maya": "太棒啦，动作特别舒展流畅，站直的时候轻轻收紧臀部就好～",
            "voice_cue_science_dr_chen": "向心蹬伸轨迹很标准，髋膝同步伸展效率高，顶部保留微屈保护关节。",
            "checks": [
                {"label": "脊柱中立", "ok": True, "detail": "全程躯干稳定无前倾"},
                {"label": "膝盖轨迹", "ok": True, "detail": "双侧对齐，发力对称"},
                {"label": "顶峰控制", "ok": True, "detail": "髋部充分伸展，节奏稳定"},
            ],
            "rep_increment": 1,
        },
    ],
}

_DEFAULT_CUES_ZH: list[dict[str, Any]] = [
    {
        "status": "good",
        "score": 90,
        "phase_detected": "concentric",
        "voice_cue": "动作轨迹很稳！保持核心收紧，发力的时候呼气，还原的时候吸气。",
        "voice_cue_iron_leo": "稳住这个节奏！核心锁紧，每一次发力都干脆利落！",
        "voice_cue_warm_maya": "动作很舒展很稳呢，跟着呼吸节奏，发力时轻轻吐气～",
        "voice_cue_science_dr_chen": "动力链传导很稳定，核心刚性良好，向心与离心的节奏比很理想。",
        "checks": [
            {"label": "核心稳定", "ok": True, "detail": "躯干保持中立不晃动"},
            {"label": "关节对齐", "ok": True, "detail": "发力方向与目标肌群一致"},
            {"label": "节奏控制", "ok": True, "detail": "向心与离心节奏均匀受控"},
        ],
        "rep_increment": 1,
    },
    {
        "status": "adjust",
        "score": 83,
        "phase_detected": "eccentric",
        "voice_cue": "往回放的时候再慢半秒，肩膀往下沉一点，别耸肩借力。",
        "voice_cue_iron_leo": "慢点放！别让重量自由落体，把肩膀沉下去，让目标肌肉吃住劲！",
        "voice_cue_warm_maya": "还原的时候可以再慢半秒钟哦，肩膀放松往下沉，感受肌肉的控制～",
        "voice_cue_science_dr_chen": "建议把离心阶段放慢半秒以增加机械张力，同时沉肩避免上斜方肌代偿。",
        "checks": [
            {"label": "核心稳定", "ok": True, "detail": "呼吸均匀，未出现憋气借力"},
            {"label": "肩带位置", "ok": False, "detail": "注意沉肩放松斜方肌"},
            {"label": "动作幅度", "ok": True, "detail": "活动范围完整到位"},
        ],
        "rep_increment": 1,
    },
]

_DEFAULT_CUES_EN: list[dict[str, Any]] = [
    {
        "status": "good",
        "score": 91,
        "phase_detected": "concentric",
        "voice_cue": "Smooth control! Keep your core braced, chest proud, and breathe steadily.",
        "voice_cue_iron_leo": "Solid rep! Lock that core in tight and drive through with power!",
        "voice_cue_warm_maya": "Beautiful, smooth rhythm! Keep breathing steadily, you're doing great.",
        "voice_cue_science_dr_chen": "Clean kinematic alignment and torso stability; concentric tempo looks great.",
        "checks": [
            {
                "label": "Neutral spine",
                "ok": True,
                "detail": "Torso stays stable and aligned",
            },
            {
                "label": "Joint tracking",
                "ok": True,
                "detail": "Clean line of pull and symmetry",
            },
            {
                "label": "Tempo control",
                "ok": True,
                "detail": "Controlled eccentric and crisp drive",
            },
        ],
        "rep_increment": 1,
    },
    {
        "status": "adjust",
        "score": 83,
        "phase_detected": "eccentric",
        "voice_cue": "Slow down the lowering phase slightly and keep your shoulders relaxed down.",
        "voice_cue_iron_leo": "Own the negative! Pack those shoulders down and control the weight!",
        "voice_cue_warm_maya": "Try softening your shoulders away from your ears and lowering a touch slower.",
        "voice_cue_science_dr_chen": "Extend the eccentric phase by half a second and depress your scapulae.",
        "checks": [
            {
                "label": "Core bracing",
                "ok": True,
                "detail": "Ribcage stacked over pelvis",
            },
            {
                "label": "Shoulder position",
                "ok": False,
                "detail": "Avoid shrugging at the transition",
            },
            {
                "label": "Range of motion",
                "ok": True,
                "detail": "Solid depth and full extension",
            },
        ],
        "rep_increment": 1,
    },
]


def _insufficient_evidence_response(
    *,
    exercise_id: str,
    exercise_name: str,
    lang: str,
    persona: str,
    reason_zh: str = "",
    reason_en: str = "",
) -> dict[str, Any]:
    """Returns a strict, honest 'insufficient_evidence' payload (never fabricates scores/reps)."""
    arch = resolve_archetype(exercise_id, exercise_name)
    is_zh = str(lang or "zh").lower().startswith("zh")
    ex_label = (
        exercise_name or exercise_id or ("当前动作" if is_zh else "this exercise")
    )

    if is_zh:
        if persona == "iron_leo":
            cue = (
                reason_zh
                or f"搭档，现在画面里看不全你做「{ex_label}」的关键关节，我绝不瞎猜敷衍你！往后退两步，让全身完整入镜我们再开练！"
            )
        elif persona == "warm_maya":
            cue = (
                reason_zh
                or f"现在镜头里还看不到你做「{ex_label}」的完整身体姿态哦～请把手机或电脑往后放远一点，让我看清你的全身动作再帮你仔细检查吧！"
            )
        elif persona == "science_dr_chen":
            cue = (
                reason_zh
                or f"当前画面缺少评估「{ex_label}」所需的关键关节特征点，证据不足无法给出准确评分。请后退1.5到2米，确保全身侧面45度入镜。"
            )
        else:
            cue = (
                reason_zh
                or f"当前画面未拍到做「{ex_label}」所需的完整身体关节，请将镜头放远并确保全身入镜后再开始。"
            )
        checks = [
            {
                "label": "画面取景完整性",
                "ok": False,
                "detail": "未完整拍到该动作必需的关节部位（如仅拍到面部/半身或光线过暗）",
            },
            {
                "label": "动作执行证据",
                "ok": False,
                "detail": "证据不足：未检测到正在做目标训练动作，拒绝盲目打分",
            },
            {
                "label": "机位调整建议",
                "ok": False,
                "detail": "请退后 1.5–2 米，呈侧方 45° 让全身关节清晰入镜",
            },
        ]
    else:
        cue = (
            reason_en
            or f"I can't see the key joints needed to judge {ex_label} yet—I won't guess your form! Step back 5–6 feet so your full body is in frame."
        )
        checks = [
            {
                "label": "Camera Framing",
                "ok": False,
                "detail": "Key joints for this exercise are out of frame or occluded",
            },
            {
                "label": "Movement Evidence",
                "ok": False,
                "detail": "Insufficient visual evidence—refusing to fabricate a score",
            },
            {
                "label": "Setup Tip",
                "ok": False,
                "detail": "Step back 5–6 ft at a 45° angle so your full body is visible",
            },
        ]

    return {
        "ok": True,
        "status": "insufficient_evidence",
        "score": None,
        "phase_detected": "not_visible",
        "voice_cue": cue,
        "checks": checks,
        "rep_increment": 0,
        "archetype": arch,
        "persona": persona or "default",
        "source": "evidence_guard",
    }


def _deterministic_form_analysis(
    exercise_id: str,
    exercise_name: str,
    lang: str,
    frame_index: int,
    persona: str = "",
) -> dict[str, Any]:
    """Produces phase-aware biomechanical feedback for explicit Simulation Mode / unit tests."""
    arch = resolve_archetype(exercise_id, exercise_name)
    is_zh = str(lang or "zh").lower().startswith("zh")
    pool = _CUES_ZH.get(arch, _DEFAULT_CUES_ZH) if is_zh else _DEFAULT_CUES_EN
    raw = dict(pool[max(frame_index, 0) % len(pool)])
    persona_key = f"voice_cue_{persona}" if persona in COACH_PERSONAS else ""
    voice_cue = raw.get(persona_key) or raw["voice_cue"]
    return {
        "ok": True,
        "status": raw["status"],
        "score": raw["score"],
        "phase_detected": raw["phase_detected"],
        "voice_cue": voice_cue,
        "checks": raw["checks"],
        "rep_increment": raw["rep_increment"],
        "archetype": arch,
        "persona": persona or "default",
        "source": "simulation_engine",
    }


def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 24000, channels: int = 1) -> bytes:
    """Wraps raw 16-bit signed little-endian PCM bytes in a standard RIFF WAV header."""
    if pcm_bytes.startswith(b"RIFF"):
        return pcm_bytes
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def _clean_tts_text(text: str) -> str:
    """Normalizes written text into natural, colloquial spoken prosody for TTS."""
    raw = str(text or "")
    cleaned = re.sub(r"[\*#_`>|]", "", raw)
    cleaned = re.sub(r"[🟢🟡🔴🟠⚪✅❌⚠️📷⏱🔥🎉💡🔬🎯♂♀⚧✨👁🔊]", "", cleaned)

    has_zh = bool(re.search(r"[\u4e00-\u9fff]", cleaned))
    if has_zh:
        # Remove pure English acronym/jargon parentheses in Chinese text, e.g. (MPS), (Why It Works)
        cleaned = re.sub(r"[（(]\s*[A-Za-z0-9\-\s/.,%+~～–—]+\s*[）)]", "", cleaned)
        # Convert remaining Chinese parentheses into natural comma pauses
        cleaned = re.sub(r"[（(]\s*([^）)]+?)\s*[）)]", r"，\1，", cleaned)
        # Remove Chinese quote brackets 「...」 so TTS doesn't pause stiffly around exercise names
        cleaned = re.sub(r"[「」『』【】]", "", cleaned)
        cleaned = cleaned.replace("·", "，")
        # Convert percentage ranges: 15%-30% -> 百分之15到30
        cleaned = re.sub(
            r"(\d+(?:\.\d+)?)\s*[%％]?\s*[–—\-~～]\s*(\d+(?:\.\d+)?)\s*[%％]",
            r"百分之\1到\2",
            cleaned,
        )
        cleaned = re.sub(r"(\d+(?:\.\d+)?)\s*[%％]", r"百分之\1", cleaned)
        # Convert numeric ranges: 25-40 -> 25到40, 2-3 -> 2到3
        cleaned = re.sub(
            r"(\d+(?:\.\d+)?)\s*[–—\-~～]\s*(\d+(?:\.\d+)?)",
            r"\1到\2",
            cleaned,
        )
        # Convert English measurement units after numbers into spoken Chinese
        cleaned = re.sub(r"(?i)(\d)\s*kcal\b", r"\1大卡", cleaned)
        cleaned = re.sub(r"(?i)(\d)\s*cal\b", r"\1大卡", cleaned)
        cleaned = re.sub(r"(?i)(\d)\s*kg\b", r"\1公斤", cleaned)
        cleaned = re.sub(r"(?i)(\d)\s*mg\b", r"\1毫克", cleaned)
        cleaned = re.sub(r"(?i)(\d)\s*ml\b", r"\1毫升", cleaned)
        cleaned = re.sub(r"(?i)(\d)\s*cm\b", r"\1厘米", cleaned)
        cleaned = re.sub(r"(?i)(\d)\s*g(?![a-zA-Z])", r"\1克", cleaned)
        cleaned = re.sub(r"(?i)(\d)\s*mins?\b", r"\1分钟", cleaned)
        cleaned = re.sub(r"(?i)(\d)\s*(?:hrs?|h)(?![a-zA-Z])", r"\1小时", cleaned)
        cleaned = re.sub(r"(?i)(\d)\s*(?:secs?|s)(?![a-zA-Z])", r"\1秒", cleaned)
        # Convert common English fitness acronyms in Chinese text into spoken Chinese
        cleaned = re.sub(r"\bRPE\s*(\d+(?:到\d+)?)", r"自觉费力程度\1级", cleaned)
        cleaned = re.sub(r"\bRIR\s*(\d+)", r"保留\1次余力", cleaned)
        cleaned = re.sub(r"\bNEAT\b", "日常非运动消耗", cleaned)
        cleaned = re.sub(r"\bMPS\b", "肌肉蛋白合成", cleaned)
        cleaned = re.sub(r"\bTEF\b", "食物热效应", cleaned)
        cleaned = re.sub(r"\bTDEE\b", "全天总消耗", cleaned)
        cleaned = re.sub(r"\bATP-CP\b", "磷酸肌酸", cleaned)
        # Slashes between Chinese words -> 或
        cleaned = re.sub(
            r"([\u4e00-\u9fff])\s*/\s*([\u4e00-\u9fff])", r"\1或\2", cleaned
        )
        # Soften stiff written words into natural spoken Mandarin
        cleaned = (
            cleaned.replace("即可", "就能")
            .replace("显著提升", "大大提高")
            .replace("显著降低", "明显减少")
            .replace("显著增强", "明显增强")
            .replace("未见", "没看到")
            .replace("置于", "放在")
        )
        # Clean up duplicate commas
        cleaned = re.sub(r"[，,]{2,}", "，", cleaned)

    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ，,")
    return cleaned[:900]


def _gemini_project_candidates() -> list[str]:
    """Returns ordered candidate GCP projects for Vertex AI Gemini calls."""
    seen: list[str] = []
    for cand in (
        os.environ.get("GEMINI_PROJECT", "").strip(),
        _DEFAULT_GEMINI_PROJECT,
        os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip(),
    ):
        if cand and cand not in seen:
            seen.append(cand)
    return seen or [_DEFAULT_GEMINI_PROJECT]


def _call_gemini_tts_sync(
    clean_text: str, persona: str, lang: str
) -> dict[str, str] | None:
    """Synthesizes natural human-like speech with Gemini 2.5 Native Audio TTS."""
    from google import genai
    from google.genai import types

    is_zh = str(lang or "zh").lower().startswith("zh")
    spec = COACH_PERSONAS.get(persona or "") or COACH_PERSONAS["iron_leo"]
    voice_name = spec.get("gemini_voice", "Fenrir")
    style_prefix = spec["tts_style_zh"] if is_zh else spec["tts_style_en"]
    prompt = f"{style_prefix} {clean_text}"

    for proj in _gemini_project_candidates():
        for loc in ("us-central1", "global"):
            try:
                client = genai.Client(vertexai=True, project=proj, location=loc)
                for model_id in _TTS_MODELS:
                    try:
                        resp = client.models.generate_content(
                            model=model_id,
                            contents=prompt,
                            config=types.GenerateContentConfig(
                                response_modalities=["AUDIO"],
                                speech_config=types.SpeechConfig(
                                    voice_config=types.VoiceConfig(
                                        prebuilt_voice_config=types.PrebuiltVoiceConfig(
                                            voice_name=voice_name
                                        )
                                    )
                                ),
                            ),
                        )
                        candidates = getattr(resp, "candidates", None) or []
                        if not candidates or not candidates[0].content:
                            continue
                        for part in candidates[0].content.parts or []:
                            inline = getattr(part, "inline_data", None)
                            raw_data = getattr(inline, "data", None) if inline else None
                            if not raw_data:
                                continue
                            if isinstance(raw_data, str):
                                raw_data = base64.b64decode(raw_data)
                            mime = str(
                                getattr(inline, "mime_type", "") or "audio/pcm"
                            ).lower()
                            if (
                                "pcm" in mime
                                or "l16" in mime
                                or not raw_data.startswith(
                                    (b"RIFF", b"ID3", b"\xff\xfb", b"\xff\xf3")
                                )
                            ):
                                wav_bytes = _pcm_to_wav(raw_data, sample_rate=24000)
                                return {
                                    "audio_b64": base64.b64encode(wav_bytes).decode(
                                        "ascii"
                                    ),
                                    "audio_mime": "audio/wav",
                                    "source": f"gemini_tts:{voice_name}",
                                }
                            return {
                                "audio_b64": base64.b64encode(raw_data).decode("ascii"),
                                "audio_mime": mime.split(";")[0] or "audio/wav",
                                "source": f"gemini_tts:{voice_name}",
                            }
                    except Exception:
                        continue
            except Exception:
                continue
    return None


# Each coach has ONE voice per language. The fallback is the same coach's
# WaveNet voice (same gender and character, ~3x faster) - never a generic one.
# Chirp3-HD takes ~1 s + ~20 ms per character, so the timeout scales with text.
COACH_CLOUD_VOICES: dict[str, dict[str, tuple[str, str]]] = {
    "iron_leo": {
        "zh": ("cmn-CN-Chirp3-HD-Fenrir", "cmn-CN-Wavenet-B"),
        "en": ("en-US-Chirp3-HD-Fenrir", "en-US-Neural2-D"),
    },
    "warm_maya": {
        "zh": ("cmn-CN-Chirp3-HD-Aoede", "cmn-CN-Wavenet-A"),
        "en": ("en-US-Chirp3-HD-Aoede", "en-US-Neural2-F"),
    },
    "science_dr_chen": {
        "zh": ("cmn-CN-Chirp3-HD-Charon", "cmn-CN-Wavenet-C"),
        "en": ("en-US-Chirp3-HD-Charon", "en-US-Neural2-J"),
    },
}

_tts_creds: Any = None
_tts_http: httpx.Client | None = None


def _tts_session() -> tuple[str, httpx.Client]:
    """Cached credentials + keep-alive HTTP client (no token refresh per call)."""
    global _tts_creds, _tts_http
    import google.auth
    from google.auth.transport.requests import Request as GoogleAuthRequest

    if _tts_creds is None:
        _tts_creds, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
    if not _tts_creds.valid:
        _tts_creds.refresh(GoogleAuthRequest())
    if _tts_http is None:
        _tts_http = httpx.Client(timeout=10.0)
    return _tts_creds.token, _tts_http


_SENTENCE_END = re.compile(r"(?<=[。！？!?；;\n.])")
_CLAUSE_BREAK = re.compile(r"[，,、：:]")


def _chirp_safe(text: str, max_sentence: int = 40) -> str:
    """Makes text safe for Chirp3-HD, which rejects (HTTP 400 "sentences too
    long") text whose sentences it cannot split. Its splitter intermittently
    misses full-width "。" with no whitespace after it, so every sentence end
    gets a newline; overly long sentences are also broken at commas."""
    out: list[str] = []
    for sentence in _SENTENCE_END.split(text):
        sentence = sentence.strip()
        if not sentence:
            continue
        while len(sentence) > max_sentence:
            cut = max(
                (m.start() for m in _CLAUSE_BREAK.finditer(sentence, 0, max_sentence)),
                default=-1,
            )
            if cut <= 0:
                cut = max_sentence - 1
            is_zh = bool(re.search(r"[\u4e00-\u9fff]", sentence))
            out.append(sentence[:cut] + ("。" if is_zh else "."))
            sentence = sentence[cut + 1 :].lstrip()
        if sentence:
            out.append(sentence)
    return "\n".join(out)


def _call_cloud_tts_sync(
    clean_text: str, persona: str, lang: str
) -> dict[str, str] | None:
    """Speaks ``clean_text`` in the coach's Cloud TTS voice (Chirp3-HD, then WaveNet)."""
    is_zh = str(lang or "zh").lower().startswith("zh")
    lang_key = "zh" if is_zh else "en"
    voices = COACH_CLOUD_VOICES.get(persona or "") or COACH_CLOUD_VOICES["iron_leo"]
    primary, fallback = voices[lang_key]
    try:
        token, http = _tts_session()
    except Exception:
        return None
    # Bill TTS to the service's own project: a service account's calls go
    # there by default (the web SA has no access to the Gemini project).
    # Set TTS_QUOTA_PROJECT to override, e.g. with user creds locally.
    headers = {"Authorization": f"Bearer {token}"}
    quota_proj = os.environ.get("TTS_QUOTA_PROJECT", "").strip()
    if quota_proj:
        headers["x-goog-user-project"] = quota_proj
    chirp_timeout = min(9.0, 2.5 + 0.035 * len(clean_text))
    attempts = [
        (primary, _chirp_safe(clean_text), chirp_timeout),
        # Chirp's "too long" 400 is intermittent: one tighter retry in the
        # coach's own voice beats switching to another voice.
        (primary, _chirp_safe(clean_text, 18), chirp_timeout),
        (fallback, clean_text, 4.0),
    ]
    last_status = 0
    for idx, (v_name, text, timeout) in enumerate(attempts):
        if idx == 1 and last_status != 400:
            continue
        last_status = 0
        try:
            r = http.post(
                "https://texttospeech.googleapis.com/v1/text:synthesize",
                headers=headers,
                json={
                    "input": {"text": text},
                    "voice": {
                        "languageCode": "-".join(v_name.split("-")[:2]),
                        "name": v_name,
                    },
                    "audioConfig": {
                        "audioEncoding": "MP3",
                        "speakingRate": 1.03 if is_zh else 1.0,
                    },
                },
                timeout=timeout,
            )
        except Exception as exc:
            log_event(
                "tts_voice_error", severity=logging.WARNING, voice=v_name, err=repr(exc)
            )
            continue  # timed out: try the coach's faster voice
        last_status = r.status_code
        if r.status_code != 200:
            log_event(
                "tts_voice_error",
                severity=logging.WARNING,
                voice=v_name,
                status=r.status_code,
                body=r.text[:200],
            )
        elif audio_b64 := r.json().get("audioContent"):
            return {
                "audio_b64": audio_b64,
                "audio_mime": "audio/mpeg",
                "source": f"cloud_tts:{v_name}",
            }
    return None


def _split_tts_chunks(text: str, max_len: int = 160) -> list[str]:
    """Splits longer speech into <=160-char sentence chunks for neural TTS."""
    if len(text) <= max_len:
        return [text]
    parts = re.split(r"(?<=[。！？；.!?;])", text)
    chunks: list[str] = []
    cur = ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if len(cur) + len(p) <= max_len:
            cur += p
        else:
            if cur:
                chunks.append(cur)
            cur = p[:max_len]
    if cur:
        chunks.append(cur)
    return chunks or [text[:max_len]]


def _proxy_headers(proxy_url: str) -> dict[str, str]:
    """Builds headers for calling the internal vision/TTS Cloud Run worker."""
    headers = {"X-Coach-Internal": _INTERNAL_HEADER}
    try:
        from google.auth.transport.requests import Request as GoogleAuthRequest
        from google.oauth2 import id_token as google_id_token

        tok = google_id_token.fetch_id_token(GoogleAuthRequest(), proxy_url)
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
    except Exception:
        pass
    return headers


_EDGE_CLOCK_SYNCED = False

_EDGE_PERSONA_VOICES: dict[str, dict[str, tuple[str, str, str]]] = {
    "iron_leo": {
        "zh": ("zh-CN-YunjianNeural", "+6%", "+0Hz"),
        "en": ("en-US-GuyNeural", "+6%", "+0Hz"),
    },
    "warm_maya": {
        "zh": ("zh-CN-XiaoxiaoNeural", "+0%", "+0Hz"),
        "en": ("en-US-AriaNeural", "+0%", "+0Hz"),
    },
    "science_dr_chen": {
        "zh": ("zh-CN-YunxiNeural", "+2%", "-2Hz"),
        "en": ("en-US-BrianNeural", "+0%", "+0Hz"),
    },
}


async def _call_edge_neural_tts(
    clean_text: str, persona: str, lang: str
) -> dict[str, str] | None:
    """Synthesizes studio-grade multi-gender neural speech (Yunjian / Xiaoxiao / Yunxi)."""
    global _EDGE_CLOCK_SYNCED
    try:
        import email.utils
        import time

        import edge_tts
        from edge_tts.drm import DRM
    except Exception:
        return None

    is_zh = str(lang or "zh").lower().startswith("zh")
    norm_lang = "zh" if is_zh else "en"
    norm_persona = (persona or "iron_leo").strip().lower()
    voice_map = (
        _EDGE_PERSONA_VOICES.get(norm_persona) or _EDGE_PERSONA_VOICES["iron_leo"]
    )
    voice_name, rate, pitch = voice_map[norm_lang]

    for attempt in range(2):
        try:
            if not _EDGE_CLOCK_SYNCED or attempt > 0:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    r = await client.head("https://www.bing.com")
                    if "Date" in r.headers:
                        srv_ts = email.utils.parsedate_to_datetime(
                            r.headers["Date"]
                        ).timestamp()
                        DRM.clock_skew_seconds = srv_ts - time.time()
                        _EDGE_CLOCK_SYNCED = True

            comm = edge_tts.Communicate(clean_text, voice_name, rate=rate, pitch=pitch)
            mp3_buf = bytearray()
            async for chunk in comm.stream():
                if chunk.get("type") == "audio" and chunk.get("data"):
                    mp3_buf.extend(chunk["data"])
            if len(mp3_buf) > 512:
                return {
                    "audio_b64": base64.b64encode(bytes(mp3_buf)).decode("ascii"),
                    "audio_mime": "audio/mpeg",
                    "source": f"neural_voice:{voice_name}",
                }
        except Exception:
            _EDGE_CLOCK_SYNCED = False
            continue
    return None


def _proxy_headers(proxy_url: str) -> dict[str, str]:
    """Builds headers for calling the internal vision/TTS Cloud Run worker."""
    headers = {"X-Coach-Internal": _INTERNAL_HEADER}
    try:
        from google.auth.transport.requests import Request as GoogleAuthRequest
        from google.oauth2 import id_token as google_id_token

        tok = google_id_token.fetch_id_token(GoogleAuthRequest(), proxy_url)
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
    except Exception:
        pass
    return headers


async def synthesize_coach_speech(
    text: str,
    persona: str = "iron_leo",
    lang: str = "zh",
) -> dict[str, str] | None:
    """Generates natural neural coach speech audio (cached in memory)."""
    clean_text = _clean_tts_text(text)
    if not clean_text:
        return None
    norm_persona = (persona or "iron_leo").strip().lower()
    norm_lang = "zh" if str(lang or "zh").lower().startswith("zh") else "en"
    cache_key = (norm_persona, norm_lang, clean_text)

    if cache_key in _TTS_CACHE:
        _TTS_CACHE.move_to_end(cache_key)
        return _TTS_CACHE[cache_key]

    if (
        os.environ.get("PYTEST_CURRENT_TEST")
        and os.environ.get("FORM_COACH_USE_GEMINI") != "1"
    ):
        wav_bytes = _pcm_to_wav(b"\x00\x00" * 120, sample_rate=24000)
        stub = {
            "audio_b64": base64.b64encode(wav_bytes).decode("ascii"),
            "audio_mime": "audio/wav",
            "source": "test_wav",
        }
        _TTS_CACHE[cache_key] = stub
        return stub

    def _remember(res: dict[str, str]) -> dict[str, str]:
        _TTS_CACHE[cache_key] = res
        if len(_TTS_CACHE) > _TTS_CACHE_MAX:
            _TTS_CACHE.popitem(last=False)
        return res

    started = time.monotonic()

    def _served(res: dict[str, str]) -> dict[str, str]:
        source = str(res.get("source") or "")
        primary = COACH_CLOUD_VOICES.get(norm_persona, COACH_CLOUD_VOICES["iron_leo"])[
            norm_lang
        ][0]
        log_event(
            "tts_served",
            severity=logging.INFO if primary in source else logging.WARNING,
            persona=norm_persona,
            lang=norm_lang,
            source=source,
            chars=len(clean_text),
            ms=int((time.monotonic() - started) * 1000),
        )
        return _remember(res)

    # Every engine below speaks with the coach's own voice; there is no
    # generic fallback (that is what made replies sound robotic / wrong).
    # 1. Optional Gemini native-audio TTS (when explicitly enabled).
    if os.environ.get("FORM_COACH_GEMINI_TTS") == "1":
        try:
            res = await asyncio.wait_for(
                asyncio.to_thread(
                    _call_gemini_tts_sync, clean_text, norm_persona, norm_lang
                ),
                timeout=2.2,
            )
            if res and res.get("audio_b64"):
                return _served(res)
        except Exception:
            pass

    # 2. Cloud Text-to-Speech: the coach's Chirp3-HD voice, then its WaveNet.
    try:
        res = await asyncio.wait_for(
            asyncio.to_thread(
                _call_cloud_tts_sync, clean_text, norm_persona, norm_lang
            ),
            timeout=14.0,
        )
        if res and res.get("audio_b64"):
            return _served(res)
    except Exception:
        pass

    # 3. Edge neural voices mapped per coach (best effort, same gender).
    try:
        res = await asyncio.wait_for(
            _call_edge_neural_tts(clean_text, norm_persona, norm_lang),
            timeout=5.0,
        )
        if res and res.get("audio_b64"):
            return _served(res)
    except Exception:
        pass

    log_event(
        "tts_failed",
        severity=logging.WARNING,
        persona=norm_persona,
        lang=norm_lang,
        chars=len(clean_text),
    )
    return None


def _call_gemini_vision_sync(
    exercise_id: str,
    exercise_name: str,
    image_bytes: bytes,
    mime_type: str,
    lang: str,
    persona: str = "",
) -> dict[str, Any]:
    """Calls Gemini multimodal vision with strict 3-gate evidence verification."""
    from google import genai
    from google.genai import types

    is_zh = str(lang or "zh").lower().startswith("zh")
    arch = resolve_archetype(exercise_id, exercise_name)
    brief = _exercise_brief(exercise_id, exercise_name, is_zh)
    required_view = (
        f"{brief['view']}。如果画面缺少这些部位，或用户只是坐在屏幕前、没有在做该动作，"
        "required_joints_visible / performing_exercise 必须设为 false！"
    )
    focus_lines = ""
    if brief["checks"]:
        focus_lines += f"本动作的关键检查点：{brief['checks']}\n"
    if brief["mistakes"]:
        focus_lines += f"本动作最常见的错误（重点检查）：{brief['mistakes']}\n"
    persona_spec = COACH_PERSONAS.get(persona or "") or COACH_PERSONAS["iron_leo"]
    persona_line = (
        persona_spec["prompt_zh"] if is_zh else persona_spec["prompt_en"]
    ) + "\n"
    lang_instruction = (
        "请全部使用自然口语化、像真人教练现场说话的中文回答（不要机械书面语）。voice_cue 控制在 18 到 42 个汉字以内。"
        if is_zh
        else "Respond in natural spoken English matching your coach persona. Keep voice_cue under 24 words."
    )

    prompt = (
        f"你现在正在通过实时摄像头观测用户训练动作：'{brief['name']}' (id: {exercise_id}, 动作类型: {arch})。\n"
        f"{focus_lines}"
        f"{persona_line}"
        f"{lang_instruction}\n\n"
        "【第一铁律：严格证据检查，绝不瞎编、绝不放水！】\n"
        f"本动作的取景与证据硬性要求：{required_view}\n"
        "在给出任何动作评分之前，你必须先如实描述画面内容 (observed_scene)，并严格核对以下 3 个证据门禁：\n"
        "1. person_visible (boolean): 画面中是否清晰拍到了真人（非黑屏、非模糊、非空房间/桌面/天花板）？\n"
        "2. required_joints_visible (boolean): 画面是否完整拍到了评估该动作所必需的全部关键身体关节？"
        "注意：如果用户只是坐在电脑/手机前，画面里只有脸部、头部、肩膀或半身，看不到下半身髋膝踝或完整发力轨迹，required_joints_visible 必须为 false！\n"
        "3. performing_exercise (boolean): 画面中的人是否真的正在做（或处于标准起始准备姿态准备做）"
        f"'{exercise_name or exercise_id}'？如果他只是普通坐着看屏幕、托腮、拿手机、站着不动或做无关动作，performing_exercise 必须为 false！\n\n"
        "【判定规则】：\n"
        "- 只要 person_visible、required_joints_visible、performing_exercise 中有任何一个为 false：\n"
        '  * status 必须设为 "insufficient_evidence"\n'
        "  * score 必须设为 null（严禁给 80、88 等虚假保底分！）\n"
        "  * rep_increment 必须设为 0\n"
        "  * voice_cue 必须用你的人设语气，诚实、具体地告诉用户你当前在画面里看到了什么（例如：'现在镜头里只能看到你的脸和肩膀，看不到髋部和膝盖' 或 '你现在正坐在电脑前还没开始做动作'），并指导用户如何调整镜头距离/角度或开始动作，绝不能假装看到了标准动作！\n"
        "  * checks 必须如实列出 3 项未通过的取景/动作证据原因（ok 全部为 false）。\n"
        "- 只有当 3 个门禁全部为 true（确实看清了完整关节且正在做该动作）时：\n"
        "  * 请严格审查脊柱中立位、关节对齐力线、动作深度/幅度，不要宽松放水！\n"
        '  * 只要有任一细节不到位（如深蹲未达水平、膝内扣、俯卧撑塌腰/肘外展、硬拉圆背、耸肩代偿），必须将对应 check 的 ok 设为 false，status 设为 "adjust"（严重变形设为 "bad"），score 严格控制在 60–84 分之间！\n'
        '  * 只有姿态真正教科书级达标时才给 status="good" 和 88–96 分。\n'
        "  * 只有当画面明确处于有效动作的底部(bottom)或发力向心阶段(concentric)时，rep_increment 才能设为 1，其余阶段设为 0。\n\n"
        "请严格返回如下 JSON 格式：\n"
        "{\n"
        '  "observed_scene": "简短客观描述画面中实际看到的人物位置、露出部位与动作状态",\n'
        '  "person_visible": true,\n'
        '  "required_joints_visible": false,\n'
        '  "performing_exercise": false,\n'
        '  "status": "insufficient_evidence" | "good" | "adjust" | "bad",\n'
        '  "score": null,\n'
        '  "phase_detected": "not_visible" | "setup" | "eccentric" | "bottom" | "concentric",\n'
        '  "voice_cue": "...",\n'
        '  "checks": [\n'
        '    {"label": "...", "ok": false, "detail": "..."},\n'
        '    {"label": "...", "ok": false, "detail": "..."},\n'
        '    {"label": "...", "ok": false, "detail": "..."}\n'
        "  ],\n"
        '  "rep_increment": 0\n'
        "}"
    )

    last_err: Exception | None = None
    parsed: dict[str, Any] | None = None
    for proj in _gemini_project_candidates():
        try:
            client = genai.Client(vertexai=True, project=proj, location="global")
            for model_id in _VISION_MODELS:
                try:
                    response = client.models.generate_content(
                        model=model_id,
                        contents=[
                            types.Part.from_bytes(
                                data=image_bytes, mime_type=mime_type
                            ),
                            types.Part.from_text(text=prompt),
                        ],
                        config=types.GenerateContentConfig(
                            temperature=0.1,
                            max_output_tokens=480,
                            response_mime_type="application/json",
                        ),
                    )
                    candidate_json = json.loads(response.text or "{}")
                    if isinstance(candidate_json, dict) and candidate_json.get(
                        "voice_cue"
                    ):
                        parsed = candidate_json
                        break
                except Exception as exc:
                    last_err = exc
                    continue
            if parsed is not None:
                break
        except Exception as exc:
            last_err = exc
            continue

    if not isinstance(parsed, dict) or not parsed.get("voice_cue"):
        raise RuntimeError(
            f"Gemini vision form analysis failed: {type(last_err).__name__ if last_err else 'empty'}"
        )

    person_ok = bool(parsed.get("person_visible"))
    joints_ok = bool(parsed.get("required_joints_visible"))
    performing_ok = bool(parsed.get("performing_exercise"))
    raw_status = str(parsed.get("status") or "").strip().lower()

    checks = parsed.get("checks")
    if not isinstance(checks, list) or not checks:
        checks = []
    checks = checks[:3]

    # Enforce strict zero-hallucination gate in code:
    if (
        not person_ok
        or not joints_ok
        or not performing_ok
        or raw_status in ("insufficient_evidence", "waiting", "not_visible")
    ):
        for chk in checks:
            if isinstance(chk, dict):
                chk["ok"] = False
        if not checks:
            checks = _insufficient_evidence_response(
                exercise_id=exercise_id,
                exercise_name=exercise_name,
                lang=lang,
                persona=persona,
            )["checks"]
        return {
            "ok": True,
            "status": "insufficient_evidence",
            "score": None,
            "phase_detected": "not_visible",
            "observed_scene": str(parsed.get("observed_scene") or ""),
            "voice_cue": str(parsed["voice_cue"]).strip(),
            "checks": checks,
            "rep_increment": 0,
            "archetype": arch,
            "persona": persona or "default",
            "source": "gemini_vision_strict",
        }

    # Person IS visible, required joints ARE visible, and exercise IS being performed:
    any_failed_check = any(
        isinstance(c, dict) and not bool(c.get("ok", True)) for c in checks
    )
    raw_score = parsed.get("score")
    try:
        score = int(raw_score) if raw_score is not None else 82
    except (TypeError, ValueError):
        score = 82
    score = max(45, min(98, score))

    if any_failed_check:
        score = min(score, 84)
        status = "bad" if score < 70 else "adjust"
    else:
        status = raw_status if raw_status in ("good", "adjust", "bad") else "good"
        if status in ("adjust", "bad"):
            score = min(score, 85)

    phase = str(parsed.get("phase_detected") or "concentric").strip().lower()
    rep_inc = (
        1 if (parsed.get("rep_increment") and phase in ("bottom", "concentric")) else 0
    )

    return {
        "ok": True,
        "status": status,
        "score": score,
        "phase_detected": phase,
        "observed_scene": str(parsed.get("observed_scene") or ""),
        "voice_cue": str(parsed["voice_cue"]).strip(),
        "checks": checks,
        "rep_increment": rep_inc,
        "archetype": arch,
        "persona": persona or "default",
        "source": "gemini_vision_strict",
    }


async def analyze_exercise_form(
    *,
    exercise_id: str,
    exercise_name: str,
    image_bytes: bytes,
    mime_type: str,
    lang: str = "zh",
    frame_index: int = 0,
    persona: str = "",
    simulation: bool = False,
    frame_hint: str = "",
    include_tts: bool = True,
    enable_gemini: bool | None = None,
) -> dict[str, Any]:
    """Evaluates a live camera frame with strict evidence gates + neural voice TTS."""
    norm_persona = (persona or "iron_leo").strip().lower()
    norm_lang = "zh" if str(lang or "zh").lower().startswith("zh") else "en"

    # 1. If the browser explicitly flagged the frame as pitch-dark / covered / blank camera:
    if frame_hint in ("dark", "covered", "empty_frame", "blank"):
        res = _insufficient_evidence_response(
            exercise_id=exercise_id,
            exercise_name=exercise_name,
            lang=norm_lang,
            persona=norm_persona,
            reason_zh="目前画面一片漆黑或镜头被遮挡，我看不清你的动作。请打开房间灯光或移开遮挡物后再试！",
            reason_en="The camera frame is too dark or covered—I can't see your posture. Please turn on the lights or uncover the lens!",
        )
        if include_tts and res.get("voice_cue"):
            tts = await synthesize_coach_speech(
                res["voice_cue"], persona=norm_persona, lang=norm_lang
            )
            if tts:
                res["audio_b64"] = tts["audio_b64"]
                res["audio_mime"] = tts["audio_mime"]
                res["tts_source"] = tts.get("source", "")
        return res

    # 2. Explicit Simulation Mode (or unit test without camera bytes):
    if simulation or not image_bytes:
        res = _deterministic_form_analysis(
            exercise_id=exercise_id,
            exercise_name=exercise_name,
            lang=norm_lang,
            frame_index=frame_index,
            persona=norm_persona,
        )
        if (
            include_tts
            and simulation
            and not os.environ.get("PYTEST_CURRENT_TEST")
            and res.get("voice_cue")
        ):
            tts = await synthesize_coach_speech(
                res["voice_cue"], persona=norm_persona, lang=norm_lang
            )
            if tts:
                res["audio_b64"] = tts["audio_b64"]
                res["audio_mime"] = tts["audio_mime"]
                res["tts_source"] = tts.get("source", "")
        return res

    # 3. Real camera frame on fitness-buddy-web: forward to companion vision service
    #    if configured (runs as fitness-buddy-agent with full Gemini access).
    proxy_url = os.environ.get("FORM_COACH_SERVICE_URL", "").strip().rstrip("/")
    is_worker = os.environ.get("IS_VISION_WORKER") == "1"
    if proxy_url and not is_worker:
        try:
            headers = await asyncio.to_thread(_proxy_headers, proxy_url)
            async with httpx.AsyncClient(timeout=_VISION_TIMEOUT_S + 3.0) as client:
                r = await client.post(
                    f"{proxy_url}/api/internal/form-check",
                    data={
                        "exercise_id": exercise_id,
                        "exercise_name": exercise_name,
                        "lang": norm_lang,
                        "persona": norm_persona,
                        "frame_index": str(frame_index),
                        "include_tts": "1" if include_tts else "0",
                    },
                    files={"image": ("frame.jpg", image_bytes, mime_type)},
                    headers=headers,
                )
                if r.status_code == 200:
                    payload = r.json()
                    if isinstance(payload, dict) and payload.get("ok"):
                        return payload
        except Exception as exc:
            log_event(
                "form_coach_proxy_fallback",
                severity=logging.WARNING,
                error=type(exc).__name__,
                detail=str(exc)[:160],
            )

    # 4. Direct Gemini Vision evaluation:
    if enable_gemini is None:
        enable_gemini = bool(
            os.environ.get("K_SERVICE")
            or os.environ.get("FORM_COACH_USE_GEMINI") == "1"
        )
    if enable_gemini:
        try:
            res = await asyncio.wait_for(
                asyncio.to_thread(
                    _call_gemini_vision_sync,
                    exercise_id,
                    exercise_name,
                    image_bytes,
                    mime_type,
                    norm_lang,
                    norm_persona,
                ),
                timeout=_VISION_TIMEOUT_S,
            )
            if include_tts and res.get("voice_cue"):
                tts = await synthesize_coach_speech(
                    res["voice_cue"], persona=norm_persona, lang=norm_lang
                )
                if tts:
                    res["audio_b64"] = tts["audio_b64"]
                    res["audio_mime"] = tts["audio_mime"]
                    res["tts_source"] = tts.get("source", "")
            return res
        except Exception as exc:
            log_event(
                "form_coach_vision_fallback",
                severity=logging.WARNING,
                error=type(exc).__name__,
                detail=str(exc)[:180],
            )

    # 5. Honest fallback for real camera frames when vision model is unreachable:
    #    NEVER fabricate a fake 'good' score or fake rep count!
    res = _insufficient_evidence_response(
        exercise_id=exercise_id,
        exercise_name=exercise_name,
        lang=norm_lang,
        persona=norm_persona,
    )
    if include_tts and res.get("voice_cue"):
        tts = await synthesize_coach_speech(
            res["voice_cue"], persona=norm_persona, lang=norm_lang
        )
        if tts:
            res["audio_b64"] = tts["audio_b64"]
            res["audio_mime"] = tts["audio_mime"]
            res["tts_source"] = tts.get("source", "")
    return res
