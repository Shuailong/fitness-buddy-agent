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

"""Real-time AI exercise form analysis & coach persona definitions.

When Vertex AI credentials are configured (Cloud Run or local ADC with
``FORM_COACH_USE_GEMINI=1``), frames are evaluated with ``gemini-2.5-flash``
for low-latency multimodal posture feedback. When offline or in tests, a
deterministic biomechanical cue engine provides phase-aware feedback tailored
to the selected coach persona so the live voice coach always responds reliably.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from web.observability import log_event

_MODEL_NAME = os.environ.get("FORM_COACH_MODEL", "gemini-2.5-flash")
_VISION_TIMEOUT_S = 6.5

COACH_PERSONAS: dict[str, dict[str, str]] = {
    "iron_leo": {
        "id": "iron_leo",
        "name_zh": "雷奥教练 · Coach Leo",
        "name_en": "Coach Leo",
        "gender": "male",
        "prompt_zh": (
            "你现在的身份是【雷奥教练 (Coach Leo)】，男，硬核热血力量与体能主教练。"
            "你的说话风格：干脆利落、充满激情与执行力、注重训练强度与动作纪律，常称呼用户为“搭档”或“兄弟/姐妹”，"
            "用简短有力的口令激励用户突破舒适区，同时严格把控安全底线。"
        ),
        "prompt_en": (
            "You are Coach Leo (male), a high-energy, no-nonsense strength & conditioning coach. "
            "Speak with punchy, direct, motivating athletic cues that push execution while keeping strict safety standards."
        ),
    },
    "warm_maya": {
        "id": "warm_maya",
        "name_zh": "林悦教练 · Coach Maya",
        "name_en": "Coach Maya",
        "gender": "female",
        "prompt_zh": (
            "你现在的身份是【林悦教练 (Coach Maya)】，女，温柔共情型身心健康与运动营养教练。"
            "你的说话风格：温暖体贴、细腻耐心、善于倾听身体信号并提供满分情绪价值，"
            "绝不说教或制造焦虑，总是先肯定用户的每一次努力，再用温和清晰的建议帮用户建立可持续习惯。"
        ),
        "prompt_en": (
            "You are Coach Maya (female), a warm, empathetic holistic fitness & nutrition coach. "
            "Speak with encouraging, supportive, stress-free guidance that celebrates consistency and body awareness."
        ),
    },
    "science_dr_chen": {
        "id": "science_dr_chen",
        "name_zh": "陈博士 · Dr. Alex Chen",
        "name_en": "Dr. Alex Chen",
        "gender": "neutral",
        "prompt_zh": (
            "你现在的身份是【陈博士 (Dr. Alex Chen)】，运动生理学与循证营养学专家。"
            "你的说话风格：冷静客观、逻辑严密、数据驱动，喜欢用通俗清晰的语言解释动作生物力学力臂、"
            "肌纤维募集、RPE 与代谢适应机制，让用户既知其然更知其所以然。"
        ),
        "prompt_en": (
            "You are Dr. Alex Chen, an evidence-based sports physiologist and biomechanics specialist. "
            "Speak with analytical precision, explaining muscle recruitment, leverage, RPE, and metabolic mechanisms clearly."
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


# Archetype classification by exercise_id / keywords
_ARCHETYPES: dict[str, tuple[str, ...]] = {
    "squat": (
        "bodyweight_squat",
        "goblet_squat",
        "barbell_back_squat",
        "box_squat_to_bench",
        "kettlebell_goblet_squat",
        "leg_press",
    ),
    "hinge": (
        "dumbbell_romanian_deadlift",
        "barbell_deadlift",
        "kettlebell_swing",
    ),
    "bridge": (
        "glute_bridge",
        "dumbbell_hip_thrust",
        "single_leg_glute_bridge",
    ),
    "lunge": (
        "reverse_lunge",
        "dumbbell_step_up",
        "standing_calf_raise",
        "hamstring_curl_machine",
    ),
    "push_horizontal": (
        "push_up",
        "incline_push_up",
        "dumbbell_bench_press",
        "dumbbell_floor_press",
        "barbell_bench_press",
    ),
    "push_vertical": (
        "dumbbell_shoulder_press",
        "dumbbell_lateral_raise",
        "dumbbell_triceps_extension",
    ),
    "pull_vertical": (
        "pull_up",
        "band_assisted_pull_up",
        "dead_hang",
        "lat_pulldown",
        "hanging_knee_raise",
    ),
    "pull_horizontal": (
        "one_arm_dumbbell_row",
        "chest_supported_dumbbell_row",
        "barbell_bent_over_row",
        "seated_cable_row",
        "band_row",
        "band_pull_apart",
        "dumbbell_biceps_curl",
    ),
    "core": (
        "plank",
        "side_plank",
        "dead_bug",
        "bird_dog",
    ),
}


def resolve_archetype(exercise_id: str, exercise_name: str = "") -> str:
    """Maps an exercise ID or free-text name to a biomechanical archetype."""
    eid = (exercise_id or "").strip().lower()
    for arch, ids in _ARCHETYPES.items():
        if eid in ids:
            return arch
    probe = f"{eid} {(exercise_name or '').lower()}"
    if any(k in probe for k in ("squat", "深蹲", "leg_press", "蹬腿")):
        return "squat"
    if any(k in probe for k in ("deadlift", "swing", "硬拉", "摆荡")):
        return "hinge"
    if any(k in probe for k in ("bridge", "thrust", "臀桥", "臀推")):
        return "bridge"
    if any(k in probe for k in ("lunge", "step", "calf", "弓步", "登阶", "提踵")):
        return "lunge"
    if any(k in probe for k in ("push_up", "bench", "floor_press", "俯卧撑", "卧推")):
        return "push_horizontal"
    if any(
        k in probe
        for k in ("shoulder", "lateral", "triceps", "推举", "侧平举", "臂屈伸")
    ):
        return "push_vertical"
    if any(k in probe for k in ("pull_up", "pulldown", "hang", "引体", "下拉", "悬垂")):
        return "pull_vertical"
    if any(k in probe for k in ("row", "curl", "pull_apart", "划船", "弯举")):
        return "pull_horizontal"
    if any(k in probe for k in ("plank", "bug", "bird_dog", "平板", "死虫", "鸟狗")):
        return "core"
    return "mobility"


_CUES_ZH: dict[str, list[dict[str, Any]]] = {
    "squat": [
        {
            "status": "good",
            "score": 91,
            "phase_detected": "eccentric",
            "voice_cue": "节奏很好！吸气缓慢下蹲，重心稳稳落在脚掌中部。",
            "voice_cue_iron_leo": "稳住！核心锁死，慢速下放，把力量压进脚掌中心！",
            "voice_cue_warm_maya": "节奏特别稳～吸气慢慢往下坐，感受臀腿温柔发力。",
            "voice_cue_science_dr_chen": "离心阶段角速度很稳，足底压力中心保持在中足，继续维持脊柱中立。",
            "checks": [
                {"label": "脊柱中立", "ok": True, "detail": "背部挺直，核心绷紧稳定"},
                {"label": "膝盖轨迹", "ok": True, "detail": "膝盖朝脚尖方向自然推进"},
                {"label": "下蹲控制", "ok": True, "detail": "离心下放节奏均匀"},
            ],
            "rep_increment": 0,
        },
        {
            "status": "adjust",
            "score": 83,
            "phase_detected": "bottom",
            "voice_cue": "注意膝盖不要内扣，向外微撑，呼气脚后跟蹬地起身！",
            "voice_cue_iron_leo": "膝盖往外顶开！别内扣！脚后跟发力直接炸起来！",
            "voice_cue_warm_maya": "稍微留意一下膝盖哦，往脚尖方向轻轻打开，呼气稳稳站起来～",
            "voice_cue_science_dr_chen": "底部出现轻微膝外翻趋势，请主动激活臀中肌外旋髋部，向心蹬伸起身。",
            "checks": [
                {"label": "脊柱中立", "ok": True, "detail": "胸口保持打开不塌腰"},
                {
                    "label": "膝盖轨迹",
                    "ok": False,
                    "detail": "底部有轻微内扣趋势，主动外旋髋部",
                },
                {
                    "label": "下蹲深度",
                    "ok": True,
                    "detail": "大腿接近水平，臀腿充分拉伸",
                },
            ],
            "rep_increment": 1,
        },
        {
            "status": "good",
            "score": 94,
            "phase_detected": "concentric",
            "voice_cue": "漂亮！这一组发力非常流畅，顶部收紧臀部，不要超伸锁死膝关节。",
            "voice_cue_iron_leo": "干得漂亮！这一发干净利落，顶峰夹紧臀部，再来一个！",
            "voice_cue_warm_maya": "太棒啦！动作特别舒展流畅，站直时轻轻收紧臀部就好～",
            "voice_cue_science_dr_chen": "向心发力轨迹非常标准，髋膝同步伸展效率极高，注意顶部保留微屈防超伸。",
            "checks": [
                {"label": "脊柱中立", "ok": True, "detail": "全程躯干稳定无前倾"},
                {"label": "膝盖轨迹", "ok": True, "detail": "双侧对齐，发力对称"},
                {"label": "顶峰控制", "ok": True, "detail": "髋部充分伸展，节奏稳定"},
            ],
            "rep_increment": 1,
        },
    ],
    "hinge": [
        {
            "status": "good",
            "score": 90,
            "phase_detected": "eccentric",
            "voice_cue": "屈髋向后推臀很标准！保持背部平直，感受大腿后侧拉伸。",
            "voice_cue_iron_leo": "好髋铰链！屁股往后坐，背给我绷成钢板，拉满后侧链！",
            "voice_cue_warm_maya": "屈髋做得很到位呢～保持背部平平的，感受大腿后侧被轻轻拉开。",
            "voice_cue_science_dr_chen": "标准的髋主导铰链模式，骨盆前倾配合坐骨后移，腘绳肌离心张力很充分。",
            "checks": [
                {
                    "label": "髋铰链模式",
                    "ok": True,
                    "detail": "以髋主导后移，非单纯弯腰",
                },
                {"label": "腰椎稳定", "ok": True, "detail": "下背部保持自然中立平直"},
                {"label": "负重贴近", "ok": True, "detail": "器械沿小腿前侧垂直移动"},
            ],
            "rep_increment": 0,
        },
        {
            "status": "adjust",
            "score": 84,
            "phase_detected": "concentric",
            "voice_cue": "肩胛骨收紧，不要耸肩圆背，呼气用臀部发力往前推髋站直！",
            "voice_cue_iron_leo": "沉肩锁背！别让重量拽弯上背，臀大肌发力往前顶髋！",
            "voice_cue_warm_maya": "肩膀轻轻往下沉一点，不要圆背哦，呼气用臀部力量慢慢推回来～",
            "voice_cue_science_dr_chen": "转换点注意背阔肌等长收缩固定肩胛，避免胸椎屈曲增加腰椎剪切力。",
            "checks": [
                {"label": "髋铰链模式", "ok": True, "detail": "腘绳肌张力保持良好"},
                {
                    "label": "腰椎稳定",
                    "ok": False,
                    "detail": "底部注意收紧背阔肌防圆背",
                },
                {"label": "顶峰锁定", "ok": True, "detail": "站起时夹臀，不靠腰椎后仰"},
            ],
            "rep_increment": 1,
        },
    ],
    "push_horizontal": [
        {
            "status": "good",
            "score": 92,
            "phase_detected": "eccentric",
            "voice_cue": "大臂与躯干呈45度角很标准，核心收紧不要塌腰，呼气推起！",
            "voice_cue_iron_leo": "角度完美！大臂45度蓄力，腹部绷紧，呼气全力推起来！",
            "voice_cue_warm_maya": "手肘角度很安全很标准～核心轻轻收住，呼气稳稳推起来吧！",
            "voice_cue_science_dr_chen": "肩外展约45度处于肩胛骨平面，盂肱关节压力最小，向心推起募集胸大肌。",
            "checks": [
                {
                    "label": "肩肘角度",
                    "ok": True,
                    "detail": "大臂约 45° 内收，保护肩袖",
                },
                {"label": "核心刚性", "ok": True, "detail": "头、肩、臀成一直线"},
                {"label": "动作幅度", "ok": True, "detail": "胸大肌充分拉伸后平稳推起"},
            ],
            "rep_increment": 1,
        },
        {
            "status": "adjust",
            "score": 85,
            "phase_detected": "bottom",
            "voice_cue": "注意手肘不要过度外展成T字，沉肩收紧肩胛骨再发力上推！",
            "voice_cue_iron_leo": "手肘往里收一点，别架成T字伤肩膀！肩胛骨夹紧再推！",
            "voice_cue_warm_maya": "手肘稍微往身体两侧收一点点会更护肩哦，沉肩吐气往上推～",
            "voice_cue_science_dr_chen": "检测到肩外展接近90度，建议内收手肘至45-60度以规避肩峰下撞击风险。",
            "checks": [
                {
                    "label": "肩肘角度",
                    "ok": False,
                    "detail": "手肘略微外飘，建议内收一点",
                },
                {"label": "核心刚性", "ok": True, "detail": "骨盆稳定未出现塌腰"},
                {"label": "呼吸配合", "ok": True, "detail": "下放吸气、推起呼气"},
            ],
            "rep_increment": 1,
        },
    ],
    "pull_horizontal": [
        {
            "status": "good",
            "score": 93,
            "phase_detected": "concentric",
            "voice_cue": "手肘贴近身体向后拉向髋部，顶峰夹紧背阔肌停留一秒，非常棒！",
            "voice_cue_iron_leo": "好拉！手肘往裤兜方向狠狠顶过去，顶峰挤爆背阔肌！",
            "voice_cue_warm_maya": "拉得真好～手肘顺着身体往后走，在顶点感受后背收紧一秒钟。",
            "voice_cue_science_dr_chen": "肩伸伴随肩胛后缩节奏协调，手肘拉向髋部最大化背阔肌下部力矩。",
            "checks": [
                {
                    "label": "肩胛启动",
                    "ok": True,
                    "detail": "先沉肩后拉肘，背部发力清晰",
                },
                {
                    "label": "躯干防旋转",
                    "ok": True,
                    "detail": "核心抗旋转稳定，无借力甩动",
                },
                {"label": "离心控制", "ok": True, "detail": "下放充分感受背阔肌拉伸"},
            ],
            "rep_increment": 1,
        },
        {
            "status": "adjust",
            "score": 84,
            "phase_detected": "eccentric",
            "voice_cue": "脖子放松不要耸肩，想象用手肘往后顶，而不是光靠小臂使劲。",
            "voice_cue_iron_leo": "别耸肩！把斜方肌压下去，用意念驱动手肘往后拉！",
            "voice_cue_warm_maya": "肩膀和脖子放松下沉哦，想象手掌只是挂钩，用手肘带着往后拉～",
            "voice_cue_science_dr_chen": "上斜方肌出现轻微代偿，请先执行肩胛骨下抑，再以肘关节引导向心收缩。",
            "checks": [
                {
                    "label": "肩胛启动",
                    "ok": False,
                    "detail": "注意下沉斜方肌，避免耸肩代偿",
                },
                {"label": "躯干稳定", "ok": True, "detail": "脊椎角度保持恒定"},
                {"label": "离心控制", "ok": True, "detail": "还原速度平稳受控"},
            ],
            "rep_increment": 1,
        },
    ],
}

_DEFAULT_CUES_ZH: list[dict[str, Any]] = [
    {
        "status": "good",
        "score": 91,
        "phase_detected": "concentric",
        "voice_cue": "动作轨迹非常稳定！保持核心收紧，发力呼气，还原吸气。",
        "voice_cue_iron_leo": "稳如泰山！核心锁紧，保持这个节奏继续推进！",
        "voice_cue_warm_maya": "动作非常稳健舒展～配合呼吸，发力时轻轻吐气，做得超棒！",
        "voice_cue_science_dr_chen": "动力链传导非常稳定，核心刚性良好，向心与离心相位时间比理想。",
        "checks": [
            {"label": "核心稳定", "ok": True, "detail": "躯干保持中立不晃动"},
            {"label": "关节对齐", "ok": True, "detail": "发力方向与目标肌群一致"},
            {"label": "节奏控制", "ok": True, "detail": "向心与离心节奏均匀受控"},
        ],
        "rep_increment": 1,
    },
    {
        "status": "adjust",
        "score": 85,
        "phase_detected": "eccentric",
        "voice_cue": "下放过程再慢半秒，沉肩收腹，专注于目标肌群的张力控制！",
        "voice_cue_iron_leo": "别急着放下来！控制住离心，让肌肉全程吃住重量！",
        "voice_cue_warm_maya": "还原的时候可以再慢半秒钟哦，肩膀放松下沉，感受肌肉的控制感～",
        "voice_cue_science_dr_chen": "建议将离心阶段延长约0.5秒以提升机械张力时间，同时注意沉肩抑制代偿。",
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
        "score": 92,
        "phase_detected": "concentric",
        "voice_cue": "Great control! Keep your core braced, chest proud, and drive smoothly.",
        "voice_cue_iron_leo": "Solid rep! Lock that core in tight and drive through with power!",
        "voice_cue_warm_maya": "Beautiful, smooth rhythm! Keep breathing steadily—you're doing great.",
        "voice_cue_science_dr_chen": "Optimal kinematic alignment and torso stability; concentric velocity looks clean.",
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
        "score": 85,
        "phase_detected": "eccentric",
        "voice_cue": "Slow down the lowering phase slightly and keep your shoulders packed down!",
        "voice_cue_iron_leo": "Own the negative! Pack those shoulders down and fight the weight!",
        "voice_cue_warm_maya": "Try softening your shoulders away from your ears and lowering a touch slower.",
        "voice_cue_science_dr_chen": "Extend eccentric duration by half a second and depress the scapulae to limit upper-trap compensation.",
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


def _deterministic_form_analysis(
    exercise_id: str,
    exercise_name: str,
    lang: str,
    frame_index: int,
    persona: str = "",
) -> dict[str, Any]:
    """Produces phase-aware biomechanical feedback when Gemini Vision is offline."""
    arch = resolve_archetype(exercise_id, exercise_name)
    is_zh = str(lang or "zh").lower().startswith("zh")
    if is_zh:
        pool = _CUES_ZH.get(arch, _DEFAULT_CUES_ZH)
    else:
        pool = _DEFAULT_CUES_EN
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
        "source": "biomechanical_engine",
    }


def _call_gemini_vision_sync(
    exercise_id: str,
    exercise_name: str,
    image_bytes: bytes,
    mime_type: str,
    lang: str,
    persona: str = "",
) -> dict[str, Any]:
    """Calls Gemini 2.5 Flash multimodal vision to evaluate live exercise form."""
    from google import genai
    from google.genai import types

    project = os.environ.get("GOOGLE_CLOUD_PROJECT")
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "global")
    client = genai.Client(vertexai=True, project=project, location=location)
    is_zh = str(lang or "zh").lower().startswith("zh")
    persona_spec = COACH_PERSONAS.get(persona or "")
    persona_line = ""
    if persona_spec:
        persona_line = (
            persona_spec["prompt_zh"] if is_zh else persona_spec["prompt_en"]
        ) + "\n"
    lang_instruction = (
        "请全部使用自然、符合你教练人设的中文回答。voice_cue 控制在 15 到 34 个汉字以内，适合实时语音播报。"
        if is_zh
        else "Respond in natural English matching your coach persona. Keep voice_cue under 18 words for live TTS."
    )
    prompt = (
        f"You are watching a user's live camera frame while they perform the exercise "
        f"'{exercise_name or exercise_id}' (id: {exercise_id}).\n"
        f"{persona_line}"
        f"{lang_instruction}\n"
        "Analyze the user's posture, joint alignment, spine neutrality, and range of motion in the image.\n"
        "If the person is not clearly visible or still setting up the camera, set status='waiting', score=80, "
        "rep_increment=0, and give a helpful framing/setup voice_cue in character.\n"
        "Return strict JSON matching this exact structure:\n"
        "{\n"
        '  "status": "good" | "adjust" | "waiting",\n'
        '  "score": 88,\n'
        '  "phase_detected": "setup" | "eccentric" | "bottom" | "concentric" | "not_visible",\n'
        '  "voice_cue": "...",\n'
        '  "checks": [\n'
        '    {"label": "...", "ok": true, "detail": "..."},\n'
        '    {"label": "...", "ok": true, "detail": "..."},\n'
        '    {"label": "...", "ok": false, "detail": "..."}\n'
        "  ],\n"
        '  "rep_increment": 1\n'
        "}"
    )
    response = client.models.generate_content(
        model=_MODEL_NAME,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
            types.Part.from_text(text=prompt),
        ],
        config=types.GenerateContentConfig(
            temperature=0.25,
            max_output_tokens=350,
            response_mime_type="application/json",
        ),
    )
    parsed = json.loads(response.text or "{}")
    if not isinstance(parsed, dict) or not parsed.get("voice_cue"):
        raise ValueError("Empty Gemini form analysis payload")
    status = str(parsed.get("status") or "good")
    if status not in ("good", "adjust", "waiting"):
        status = "good"
    score = max(50, min(99, int(parsed.get("score") or 88)))
    checks = parsed.get("checks")
    if not isinstance(checks, list) or not checks:
        checks = []
    return {
        "ok": True,
        "status": status,
        "score": score,
        "phase_detected": str(parsed.get("phase_detected") or "concentric"),
        "voice_cue": str(parsed["voice_cue"]).strip(),
        "checks": checks[:3],
        "rep_increment": 1 if parsed.get("rep_increment") else 0,
        "archetype": resolve_archetype(exercise_id, exercise_name),
        "persona": persona or "default",
        "source": "gemini_vision",
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
    enable_gemini: bool | None = None,
) -> dict[str, Any]:
    """Evaluates an exercise camera frame with Gemini Vision + deterministic fallback."""
    if enable_gemini is None:
        enable_gemini = bool(
            os.environ.get("K_SERVICE")
            or os.environ.get("FORM_COACH_USE_GEMINI") == "1"
        )
    if enable_gemini and image_bytes:
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(
                    _call_gemini_vision_sync,
                    exercise_id,
                    exercise_name,
                    image_bytes,
                    mime_type,
                    lang,
                    persona,
                ),
                timeout=_VISION_TIMEOUT_S,
            )
        except Exception as exc:
            log_event(
                "form_coach_vision_fallback",
                severity=logging.WARNING,
                error=type(exc).__name__,
                detail=str(exc)[:180],
            )
    return _deterministic_form_analysis(
        exercise_id=exercise_id,
        exercise_name=exercise_name,
        lang=lang,
        frame_index=frame_index,
        persona=persona,
    )
