// Coach Persona system: 3 selectable coaching personalities with distinct
// gender, tone, visual identity, and Neural AI TTS voice synthesis.
import { el, icon } from "./util.js";
import { getLang } from "./i18n.js";
import { openModal, closeModal, showToast } from "./modal.js";
import { track } from "./telemetry.js";

const STORAGE_KEY = "fb_coach_persona_v1";
const DEFAULT_PERSONA_ID = "iron_leo";
const listeners = new Set();

// Silent 1-sample WAV used to unlock browser audio playback on user click gestures
const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

let sharedAudio = null;
let audioUnlocked = false;
let currentPlayToken = 0;
let activeAudioFinish = null;
const ttsAudioCache = new Map();
const ttsInFlight = new Map();

export const PERSONAS = [
  {
    id: "iron_leo",
    icon: "fitness-center",
    avatarText: "LEO",
    accentClass: "persona-leo",
    gender: "male",
    voice: {
      pitch: 1.0,
      rate: 1.03,
      voiceHints: ["Yunjian", "Yunxi", "Yunyang", "Google 普通话", "Binbin", "Lili", "Meijia", "Daniel", "Google US English"],
    },
    zh: {
      name: "雷奥教练 · Coach Leo",
      shortName: "雷奥教练",
      genderTag: "♂ 男 · 硬核铁血主教练",
      styleTitle: "高能热血 · 渐进超负荷 · 严抠动作执行",
      tags: ["力量突破", "干脆利落", "拒绝借口"],
      bio: "前竞技体能主教练，崇尚有效训练容量与标准动作纪律。说话直接有力，在你想偷懒的最后两下给你最猛的推力，同时死守关节安全底线。",
      quote: "「核心绷紧！别跟重量讨价还价，高质量完成这一组，我替你盯紧每一度关节轨迹！」",
      sampleTts: "嘿，搭档！我是雷奥教练。今天咱们不整虚的，把核心收紧，每一组都拿出身体的最佳状态，准备好咱们就开练！",
      sampleAudio: "/static/audio/personas/iron_leo_zh.mp3",
      tipPrefix: "雷奥教练划重点：",
    },
    en: {
      name: "Coach Leo",
      shortName: "Coach Leo",
      genderTag: "♂ Male · Hardcore Strength Coach",
      styleTitle: "High-Energy · Progressive Overload · No-Nonsense",
      tags: ["Strength & Power", "Direct & Punchy", "Strict Form"],
      bio: "Former strength & conditioning head coach focused on progressive overload and crisp execution. Direct, fiery motivation that pushes you through the last two reps safely.",
      quote: "\"Brace that core! Don't negotiate with the bar—own every rep with textbook control!\"",
      sampleTts: "Hey partner, I'm Coach Leo! Lock in your focus, brace your core, and let's make every single rep count today!",
      sampleAudio: "/static/audio/personas/iron_leo_en.mp3",
      tipPrefix: "Coach Leo's Take:",
    },
  },
  {
    id: "warm_maya",
    icon: "favorite",
    avatarText: "MAYA",
    accentClass: "persona-maya",
    gender: "female",
    voice: {
      pitch: 1.0,
      rate: 1.0,
      voiceHints: ["Xiaoxiao", "Xiaoyi", "Google 國語", "Google 普通话", "Meijia", "Mei-Jia", "Yue", "Lili", "Samantha"],
    },
    zh: {
      name: "林悦教练 · Coach Maya",
      shortName: "林悦教练",
      genderTag: "♀ 女 · 温柔共情身心教练",
      styleTitle: "温暖治愈 · 可持续习惯 · 零焦虑陪伴",
      tags: ["温柔鼓励", "外食友好", "倾听身体"],
      bio: "专注女性与大众可持续体态管理、运动营养与反焦虑饮食。永远先看见你的努力与进步，帮你把健康融入生活，而不是让训练变成压力。",
      quote: "「哪怕今天只完成了 20 分钟，也是对身体超棒的投资～放轻松，我们一步步稳稳变强！」",
      sampleTts: "嗨，我是林悦教练，今天能打开训练就已经超棒啦，放轻松，跟着自己的呼吸节奏，我们一起开心地动起来吧！",
      sampleAudio: "/static/audio/personas/warm_maya_zh.mp3",
      tipPrefix: "林悦教练贴心提醒：",
    },
    en: {
      name: "Coach Maya",
      shortName: "Coach Maya",
      genderTag: "♀ Female · Empathetic Wellness Coach",
      styleTitle: "Warm & Mindful · Sustainable Habits · Stress-Free",
      tags: ["Empathetic", "Flexible Diet", "Body Awareness"],
      bio: "Holistic fitness and nutrition coach who believes consistency beats perfection. Celebrates every win and helps you build lifelong habits without guilt.",
      quote: "\"Even a 20-minute session is a wonderful gift to your body. Breathe easy—we're building this step by step!\"",
      sampleTts: "Hi there, I'm Coach Maya! Take a deep breath, listen to your body, and let's enjoy a great session together.",
      sampleAudio: "/static/audio/personas/warm_maya_en.mp3",
      tipPrefix: "Coach Maya's Note:",
    },
  },
  {
    id: "science_dr_chen",
    icon: "psychology",
    avatarText: "CHEN",
    accentClass: "persona-chen",
    gender: "neutral",
    voice: {
      pitch: 1.0,
      rate: 1.0,
      voiceHints: ["Yunxi", "Yunyang", "Google 普通话", "Sin-ji", "Meijia", "Arthur", "Daniel", "Google US English"],
    },
    zh: {
      name: "陈博士 · Dr. Alex Chen",
      shortName: "陈博士",
      genderTag: "⚧ 运动生理学与营养学博士",
      styleTitle: "循证科学 · 生物力学拆解 · 数据驱动",
      tags: ["运动生物力学", "代谢机制", "精准量化"],
      bio: "运动人体科学实验室出身，擅长用第一性原理拆解力臂、肌纤维募集、RPE 与营养代谢，让你不仅练对动作，更彻底搞懂背后的科学逻辑。",
      quote: "「将离心阶段控制在 2.5 秒可显著提升机械张力；我们用数据说话，精准优化你的每一卡路里。」",
      sampleTts: "你好，我是陈博士。今天我们会结合运动生物力学和代谢数据，一步步陪你把每个动作细节都做到科学、精准。",
      sampleAudio: "/static/audio/personas/science_dr_chen_zh.mp3",
      tipPrefix: "陈博士循证解析：",
    },
    en: {
      name: "Dr. Alex Chen",
      shortName: "Dr. Chen",
      genderTag: "⚧ PhD · Sports Science & Biomechanics",
      styleTitle: "Evidence-Based · Biomechanics · Data-Driven",
      tags: ["Biomechanics", "Metabolic Lab", "RPE Precision"],
      bio: "Exercise physiologist and sports nutrition researcher. Breaks down moment arms, motor-unit recruitment, and energy balance with crystal-clear scientific logic.",
      quote: "\"A controlled 2.5-second eccentric maximizes mechanical tension. Let's optimize your protocol with data.\"",
      sampleTts: "Hello, I'm Doctor Alex Chen. Let's apply evidence-based biomechanics and metabolic data to optimize your training today.",
      sampleAudio: "/static/audio/personas/science_dr_chen_en.mp3",
      tipPrefix: "Dr. Chen's Lab Note:",
    },
  },
];

export function getPersonaId() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && PERSONAS.some((p) => p.id === saved)) return saved;
  } catch { /* ignore storage errors */ }
  return DEFAULT_PERSONA_ID;
}

export function getPersona(id = getPersonaId(), lang = getLang()) {
  const found = PERSONAS.find((p) => p.id === id) || PERSONAS[0];
  const l = lang === "zh" ? "zh" : "en";
  return { ...found, copy: found[l] };
}

export function setPersonaId(id) {
  const valid = PERSONAS.find((p) => p.id === id) ? id : DEFAULT_PERSONA_ID;
  try {
    localStorage.setItem(STORAGE_KEY, valid);
  } catch { /* ignore */ }
  track("persona_change", { persona: valid });
  for (const fn of listeners) {
    try { fn(valid); } catch { /* ignore */ }
  }
  return valid;
}

export function onPersonaChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSharedAudio() {
  if (typeof window === "undefined") return null;
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.preload = "auto";
    sharedAudio.playsInline = true;
  }
  return sharedAudio;
}

/**
 * Unlocks browser audio playback on user gesture (click/tap) so subsequent
 * async live-coaching cues play reliably without autoplay blocking.
 */
export function unlockCoachAudio() {
  if (typeof window === "undefined") return;
  try {
    const audio = getSharedAudio();
    if (audio && !audioUnlocked && !activeAudioFinish) {
      audioUnlocked = true;
      audio.src = SILENT_WAV_DATA_URI;
      audio.volume = 0.01;
      const p = audio.play();
      if (p && typeof p.then === "function") {
        p.then(() => {
          if (audio.src === SILENT_WAV_DATA_URI && !activeAudioFinish) {
            audio.volume = 1.0;
          }
        }).catch(() => {
          audioUnlocked = false;
          if (!activeAudioFinish) audio.volume = 1.0;
        });
      }
    }
    if ("speechSynthesis" in window && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
    }
  } catch { /* ignore */ }
}

function playAudioDataUri(dataUri, { rate = 1.0, token, onStart, onEnd } = {}) {
  return new Promise((resolve) => {
    const audio = getSharedAudio();
    if (!audio || token !== currentPlayToken) {
      if (onEnd) onEnd();
      resolve(false);
      return;
    }
    if (activeAudioFinish) {
      try { activeAudioFinish(false); } catch { /* ignore */ }
    }
    let settled = false;
    let safetyTimer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      if (activeAudioFinish === finish) activeAudioFinish = null;
      audio.onended = null;
      audio.onerror = null;
      if (onEnd) onEnd();
      resolve(ok);
    };
    activeAudioFinish = finish;
    safetyTimer = setTimeout(() => finish(true), 16000);
    try {
      audioUnlocked = true;
      audio.pause();
      audio.src = dataUri;
      audio.volume = 1.0;
      audio.preservesPitch = true;
      audio.playbackRate = rate;
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.then === "function") {
        playPromise
          .then(() => {
            if (onStart) onStart();
          })
          .catch(() => finish(false));
      } else {
        if (onStart) onStart();
      }
    } catch {
      finish(false);
    }
  });
}

// Pre-warm speechSynthesis voice catalog on load (Chrome populates voices asynchronously)
if (typeof window !== "undefined" && "speechSynthesis" in window) {
  try {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      try { window.speechSynthesis.getVoices(); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

/**
 * Normalizes written Chinese/English UI text into natural, colloquial spoken prosody
 * so TTS engines never read "25–40g" as "25 dash 40 G" or spell out "(MPS)".
 */
export function normalizeSpeechText(text, lang = "zh") {
  let s = String(text || "")
    .replace(/[\*#_`>|]/g, "")
    .replace(/[🟢🟡🔴🟠⚪✅❌⚠️📷⏱🔥🎉💡🔬🎯♂♀⚧✨👁🔊]/g, "");

  const hasZh = /[\u4e00-\u9fff]/.test(s) || lang === "zh";
  if (hasZh) {
    s = s
      // Remove pure English acronym/jargon parentheses in Chinese sentences, e.g. （MPS）, (Why It Works)
      .replace(/[（(]\s*[A-Za-z0-9\-\s/.,%+~～–—]+\s*[）)]/g, "")
      // Turn remaining Chinese parenthetical notes into natural comma pauses
      .replace(/[（(]\s*([^）)]+?)\s*[）)]/g, "，$1，")
      // Remove stiff quote brackets
      .replace(/[「」『』【】]/g, "")
      .replace(/·/g, "，")
      // Percentage ranges: 15%–30% -> 百分之15到30
      .replace(/(\d+(?:\.\d+)?)\s*[%％]?\s*[–—\-~～]\s*(\d+(?:\.\d+)?)\s*[%％]/g, "百分之$1到$2")
      .replace(/(\d+(?:\.\d+)?)\s*[%％]/g, "百分之$1")
      // Numeric ranges: 25–40 -> 25到40
      .replace(/(\d+(?:\.\d+)?)\s*[–—\-~～]\s*(\d+(?:\.\d+)?)/g, "$1到$2")
      // Measurement units after numbers
      .replace(/(\d)\s*kcal\b/gi, "$1大卡")
      .replace(/(\d)\s*cal\b/gi, "$1大卡")
      .replace(/(\d)\s*kg\b/gi, "$1公斤")
      .replace(/(\d)\s*mg\b/gi, "$1毫克")
      .replace(/(\d)\s*ml\b/gi, "$1毫升")
      .replace(/(\d)\s*cm\b/gi, "$1厘米")
      .replace(/(\d)\s*g(?![a-zA-Z])/gi, "$1克")
      .replace(/(\d)\s*mins?\b/gi, "$1分钟")
      .replace(/(\d)\s*(?:hrs?|h)(?![a-zA-Z])/gi, "$1小时")
      .replace(/(\d)\s*(?:secs?|s)(?![a-zA-Z])/gi, "$1秒")
      // Fitness acronyms in Chinese text
      .replace(/\bRPE\s*(\d+(?:到\d+)?)/g, "自觉费力程度$1级")
      .replace(/\bRIR\s*(\d+)/g, "保留$1次余力")
      .replace(/\bNEAT\b/g, "日常非运动消耗")
      .replace(/\bMPS\b/g, "肌肉蛋白合成")
      .replace(/\bTEF\b/g, "食物热效应")
      .replace(/\bTDEE\b/g, "全天总消耗")
      .replace(/\bATP-CP\b/g, "磷酸肌酸")
      // Slashes between Chinese chars
      .replace(/([\u4e00-\u9fff])\s*\/\s*([\u4e00-\u9fff])/g, "$1或$2")
      // Soften stiff written words into conversational Mandarin
      .replace(/即可/g, "就能")
      .replace(/显著提升/g, "大大提高")
      .replace(/显著降低/g, "明显减少")
      .replace(/显著增强/g, "明显增强")
      .replace(/未见/g, "没看到")
      .replace(/[，,]{2,}/g, "，");
  }
  return s.replace(/\s+/g, " ").replace(/^[，,\s]+|[，,\s]+$/g, "").trim();
}

function pickBestSpeechVoice(voices, persona, lang) {
  const isZh = lang === "zh";
  const prefix = isZh ? "zh" : "en";
  const langVoices = (voices || []).filter((v) => {
    const l = String(v.lang || "").toLowerCase();
    return l.startsWith(prefix) || (isZh && l.includes("cmn"));
  });
  if (!langVoices.length) return null;

  const hints = (persona && persona.voice && persona.voice.voiceHints) || [];
  let bestVoice = langVoices[0];
  let bestScore = -999;

  for (const v of langVoices) {
    const name = String(v.name || "");
    const lower = name.toLowerCase();
    let score = 0;

    // 1. Persona-specific preferred voice hints (in priority order)
    for (let i = 0; i < hints.length; i++) {
      if (lower.includes(hints[i].toLowerCase())) {
        score += 120 - i * 8;
        break;
      }
    }

    // 2. Strongly prefer cloud/neural/natural voices over legacy offline robotic synthesizers
    if (lower.includes("natural") || lower.includes("online")) score += 90;
    if (lower.includes("google") || !v.localService) score += 75;
    if (lower.includes("premium") || lower.includes("enhanced") || lower.includes("siri")) score += 60;
    if (lower.includes("meijia") || lower.includes("mei-jia") || lower.includes("sin-ji")) score += 40;

    // 3. Heavy penalty for legacy macOS offline "Tingting" which sounds robotic
    if (lower.includes("tingting") || lower.includes("ting-ting")) score -= 80;

    if (score > bestScore) {
      bestScore = score;
      bestVoice = v;
    }
  }
  return bestVoice;
}

// Illustrated SVG portraits for each of the 3 Coach Personas
const COACH_AVATAR_SVGS = {
  iron_leo: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="bg-leo" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FF7A45"/>
        <stop offset="100%" stop-color="#B8320A"/>
      </linearGradient>
    </defs>
    <circle cx="32" cy="32" r="31" fill="url(#bg-leo)"/>
    <path d="M12 58c3-11 11-16 20-16s17 5 20 16" fill="#1F242D"/>
    <path d="M23 43h18l-3 15H26l-3-15z" fill="#FF6B35" opacity="0.85"/>
    <rect x="27" y="36" width="10" height="9" rx="4" fill="#F4B393"/>
    <path d="M20 24c0-7 5-12 12-12s12 5 12 12v5c0 7-5 12-12 12s-12-5-12-12v-5z" fill="#FAD1B8"/>
    <path d="M18 22c1-8 6-13 14-13 6 0 11 3 13 9l-3 4H20l-2 0z" fill="#231F20"/>
    <rect x="19" y="19" width="26" height="4.5" rx="2.2" fill="#CCFF00"/>
    <circle cx="27" cy="27" r="2" fill="#1E2024"/>
    <circle cx="37" cy="27" r="2" fill="#1E2024"/>
    <path d="M24 23.5l5 1M40 23.5l-5 1" stroke="#231F20" stroke-width="2" stroke-linecap="round"/>
    <path d="M27.5 33.5c2.5 2 6.5 2 9 0" stroke="#231F20" stroke-width="2.2" stroke-linecap="round"/>
  </svg>`,
  warm_maya: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="bg-maya" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#F472B6"/>
        <stop offset="100%" stop-color="#9D174D"/>
      </linearGradient>
    </defs>
    <circle cx="32" cy="32" r="31" fill="url(#bg-maya)"/>
    <circle cx="46" cy="18" r="7" fill="#3B1D2E"/>
    <path d="M13 58c3-10 10-15 19-15s16 5 19 15" fill="#2A1B2E"/>
    <path d="M23 43c3 4 15 4 18 0l2 15H21l2-15z" fill="#F9A8D4"/>
    <rect x="28" y="36" width="8" height="9" rx="4" fill="#F7C6B5"/>
    <path d="M21 25c0-6.5 5-11.5 11-11.5S43 18.5 43 25v4.5C43 36 38 40.5 32 40.5S21 36 21 29.5V25z" fill="#FFE0D2"/>
    <path d="M19 25c0-9 6-14 13-14s13 5 13 14c-3-4-7-6-13-6s-10 2-13 6z" fill="#3B1D2E"/>
    <path d="M20 20.5c4-2.5 20-2.5 24 0" stroke="#FDE047" stroke-width="3" stroke-linecap="round"/>
    <circle cx="27.5" cy="27.5" r="1.9" fill="#2A1B2E"/>
    <circle cx="36.5" cy="27.5" r="1.9" fill="#2A1B2E"/>
    <circle cx="24.5" cy="31" r="2.2" fill="#FB7185" opacity="0.45"/>
    <circle cx="39.5" cy="31" r="2.2" fill="#FB7185" opacity="0.45"/>
    <path d="M27.5 33c2.5 2.6 6.5 2.6 9 0" stroke="#2A1B2E" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  science_dr_chen: `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs>
      <linearGradient id="bg-chen" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#38BDF8"/>
        <stop offset="100%" stop-color="#0369A1"/>
      </linearGradient>
    </defs>
    <circle cx="32" cy="32" r="31" fill="url(#bg-chen)"/>
    <path d="M13 58c3-10 10-15 19-15s16 5 19 15" fill="#0F172A"/>
    <path d="M24 43l8 9 8-9 3 15H21l3-15z" fill="#E0F2FE"/>
    <rect x="27.5" y="36" width="9" height="9" rx="4" fill="#F1C6B3"/>
    <path d="M20.5 24.5c0-6.8 5.2-12 11.5-12s11.5 5.2 11.5 12v5c0 6.8-5.2 11.5-11.5 11.5s-11.5-4.7-11.5-11.5v-5z" fill="#FAD9C8"/>
    <path d="M19.5 23c.5-8 5.5-12.5 12.5-12.5S44 15 44.5 23c-2.5-3.5-6.5-5-12.5-5s-10 1.5-12.5 5z" fill="#1E293B"/>
    <rect x="22.5" y="24.5" width="8" height="5.5" rx="1.5" stroke="#0F172A" stroke-width="1.8" fill="#E0F2FE" fill-opacity="0.35"/>
    <rect x="33.5" y="24.5" width="8" height="5.5" rx="1.5" stroke="#0F172A" stroke-width="1.8" fill="#E0F2FE" fill-opacity="0.35"/>
    <path d="M30.5 27h3" stroke="#0F172A" stroke-width="1.8"/>
    <circle cx="26.5" cy="27.2" r="1.5" fill="#0F172A"/>
    <circle cx="37.5" cy="27.2" r="1.5" fill="#0F172A"/>
    <path d="M28 34c2.2 1.6 5.8 1.6 8 0" stroke="#0F172A" stroke-width="1.9" stroke-linecap="round"/>
  </svg>`,
};

/**
 * Renders an illustrated SVG portrait avatar for the given Coach Persona.
 */
export function coachAvatar(personaId = getPersonaId(), { size = "md", online = false, cls = "" } = {}) {
  const p = getPersona(personaId, getLang());
  const svgHtml = COACH_AVATAR_SVGS[p.id] || COACH_AVATAR_SVGS.iron_leo;
  const wrap = el("span", {
    class: `bot-avatar coach-svg-avatar ${p.accentClass}${size === "lg" ? " lg" : ""}${size === "xl" ? " xl" : ""}${cls ? ` ${cls}` : ""}`,
    "aria-hidden": "true",
    html: svgHtml,
  });
  if (online) {
    wrap.append(el("i", { class: "online" }));
  }
  return wrap;
}

/**
 * Splits a normalized speech string into natural sentence chunks (<= maxLen chars)
 * so long Coach chat replies start speaking within <1s and never exceed TTS limits.
 */
export function splitSpeechSentences(text, maxLen = 140) {
  const s = String(text || "").trim();
  if (!s) return [];
  if (s.length <= maxLen) return [s];
  const rawParts = s.split(/(?<=[。！？.!?\n；;])/);
  const chunks = [];
  let buf = "";
  for (const part of rawParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (buf && (buf.length + trimmed.length + 1) > maxLen) {
      chunks.push(buf.trim());
      buf = trimmed;
    } else if (trimmed.length > maxLen) {
      if (buf) {
        chunks.push(buf.trim());
        buf = "";
      }
      for (let i = 0; i < trimmed.length; i += maxLen) {
        chunks.push(trimmed.slice(i, i + maxLen));
      }
    } else {
      buf = buf ? `${buf} ${trimmed}` : trimmed;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.slice(0, 8);
}

function speakSingleWebSpeechUtterance(spokenText, { persona, lang, token, onStart } = {}) {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || !spokenText || token !== currentPlayToken) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const synth = window.speechSynthesis;
      if (synth.paused) synth.resume();
      const utter = new SpeechSynthesisUtterance(spokenText);
      window.__activeCoachUtterance = utter;

      const voices = synth.getVoices ? synth.getVoices() : [];
      const picked = pickBestSpeechVoice(voices, persona, lang);
      if (picked) {
        utter.voice = picked;
        utter.lang = picked.lang || (lang === "zh" ? "zh-CN" : "en-US");
      } else {
        utter.lang = lang === "zh" ? "zh-CN" : "en-US";
      }
      utter.pitch = (persona && persona.voice && persona.voice.pitch) || 1.0;
      utter.rate = (persona && persona.voice && persona.voice.rate) || 1.0;

      utter.onstart = () => {
        if (onStart) onStart();
      };
      utter.onend = () => finish(true);
      utter.onerror = () => finish(false);

      const maxWaitMs = Math.min(12000, Math.max(3500, spokenText.length * 300));
      setTimeout(() => finish(true), maxWaitMs);
      synth.speak(utter);
    } catch {
      finish(false);
    }
  });
}

async function speakWithWebSpeechFallback(text, { personaId, lang, token, onStart, onEnd } = {}) {
  const spokenText = normalizeSpeechText(text, lang);
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !spokenText || token !== currentPlayToken) {
    if (onEnd) onEnd();
    return false;
  }
  try {
    const synth = window.speechSynthesis;
    if (synth.speaking || synth.pending) synth.cancel();
  } catch { /* ignore */ }

  const p = getPersona(personaId, lang);
  const chunks = splitSpeechSentences(spokenText, 120);
  let started = false;
  let anyOk = false;
  for (const chunk of chunks) {
    if (token !== currentPlayToken) break;
    const ok = await speakSingleWebSpeechUtterance(chunk, {
      persona: p,
      lang,
      token,
      onStart: !started ? () => { started = true; if (onStart) onStart(); } : null,
    });
    if (ok) anyOk = true;
    else break;
  }
  if (onEnd) onEnd();
  return anyOk;
}

async function fetchNeuralTts(clean, personaId, lang) {
  const cacheKey = `${personaId}:${lang}:${clean}`;
  if (ttsAudioCache.has(cacheKey)) {
    return ttsAudioCache.get(cacheKey);
  }
  if (ttsInFlight.has(cacheKey)) {
    return ttsInFlight.get(cacheKey);
  }
  const job = (async () => {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 6500) : null;
    try {
      const resp = await fetch("/api/tts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean, persona: personaId, lang }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (data && data.ok && data.audio_b64) {
        const mime = data.audio_mime || "audio/mpeg";
        const entry = {
          uri: `data:${mime};base64,${data.audio_b64}`,
          mime,
          source: data.source || "",
        };
        ttsAudioCache.set(cacheKey, entry);
        return entry;
      }
    } catch { /* fall through */ } finally {
      if (timer) clearTimeout(timer);
      ttsInFlight.delete(cacheKey);
    }
    return null;
  })();
  ttsInFlight.set(cacheKey, job);
  return job;
}

export function prefetchPersonaSamples(lang = getLang()) {
  if (typeof window === "undefined") return;
  for (const raw of PERSONAS) {
    const p = getPersona(raw.id, lang);
    const staticUrl = p.copy && p.copy.sampleAudio;
    if (staticUrl) {
      fetch(staticUrl, { credentials: "same-origin" }).catch(() => {});
    }
  }
}

/**
 * Scheme A: Plays the pre-generated studio neural MP3 asset synchronously inside
 * the user click gesture (0ms synthesis latency, 100% immune to browser autoplay blocking).
 * Automatically falls back to dynamic TTS if the static file fails to play.
 */
export async function playStaticPersonaSample(personaId = getPersonaId(), lang = getLang(), { onStart, onEnd } = {}) {
  const p = getPersona(personaId, lang);
  const staticUrl = p.copy && p.copy.sampleAudio;
  if (!staticUrl) {
    return speakCoachText(p.copy.sampleTts, { personaId: p.id, lang, onStart, onEnd });
  }

  if (activeAudioFinish) {
    try { activeAudioFinish(false); } catch { /* ignore */ }
  }
  try {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  } catch { /* ignore */ }

  const token = ++currentPlayToken;
  let ended = false;
  const doneEnd = () => {
    if (ended) return;
    ended = true;
    if (onEnd) {
      try { onEnd(); } catch { /* ignore */ }
    }
  };

  // Play the static MP3 directly in the synchronous click event frame
  const played = await playAudioDataUri(staticUrl, {
    rate: 1.0,
    token,
    onStart,
    onEnd: doneEnd,
  });
  if (played || token !== currentPlayToken) {
    doneEnd();
    return played;
  }

  // Fallback to dynamic Scheme B TTS if static asset failed
  return speakCoachText(p.copy.sampleTts, {
    personaId: p.id,
    lang,
    onStart,
    onEnd: doneEnd,
  });
}

/**
 * Speaks coaching text using Backend Neural TTS (Scheme B) with sentence chunking
 * so long Coach chat messages start speaking quickly and play reliably.
 */
export async function speakCoachText(
  text,
  { personaId = getPersonaId(), lang = getLang(), audioB64 = "", audioMime = "", onStart, onEnd } = {},
) {
  let ended = false;
  const doneEnd = () => {
    if (ended) return;
    ended = true;
    if (onEnd) {
      try { onEnd(); } catch { /* ignore */ }
    }
  };

  const clean = normalizeSpeechText(text, lang);
  if (!clean) {
    doneEnd();
    return false;
  }

  // Stop any previously active speech before starting the new utterance
  if (activeAudioFinish) {
    try { activeAudioFinish(false); } catch { /* ignore */ }
  }
  try {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  } catch { /* ignore */ }

  const token = ++currentPlayToken;
  const p = getPersona(personaId, lang);
  const fullCacheKey = `${p.id}:${lang}:${clean}`;

  try {
    // 1. Play pre-bundled neural audio (e.g. returned directly by /api/form-check or WebSocket)
    if (audioB64) {
      const mime = audioMime || "audio/mpeg";
      const uri = `data:${mime};base64,${audioB64}`;
      ttsAudioCache.set(fullCacheKey, { uri, mime, source: "bundled" });
      const played = await playAudioDataUri(uri, { rate: 1.0, token, onStart, onEnd: doneEnd });
      if (played || token !== currentPlayToken) {
        doneEnd();
        return played;
      }
    }

    // 2. Split long messages into sentence chunks (<= 150 chars) so first chunk plays fast
    const chunks = splitSpeechSentences(clean, 150);
    if (chunks.length > 0) {
      // Prefetch first two chunks in parallel for zero gap between sentences
      const pending = chunks.map((chunk, idx) => (idx <= 1 ? fetchNeuralTts(chunk, p.id, lang) : null));
      let started = false;
      let allNeuralOk = true;
      for (let i = 0; i < chunks.length; i++) {
        if (token !== currentPlayToken) {
          doneEnd();
          return false;
        }
        if (!pending[i]) pending[i] = fetchNeuralTts(chunks[i], p.id, lang);
        if (i + 1 < chunks.length && !pending[i + 1]) {
          pending[i + 1] = fetchNeuralTts(chunks[i + 1], p.id, lang);
        }
        const entry = await pending[i];
        if (token !== currentPlayToken) {
          doneEnd();
          return false;
        }
        if (!entry || !entry.uri) {
          allNeuralOk = false;
          break;
        }
        const played = await playAudioDataUri(entry.uri, {
          rate: 1.0,
          token,
          onStart: !started ? () => { started = true; if (onStart) onStart(); } : null,
        });
        if (!played) {
          allNeuralOk = false;
          break;
        }
      }
      if (allNeuralOk || token !== currentPlayToken) {
        doneEnd();
        return allNeuralOk;
      }
    }

    // 3. Fallback to browser Web Speech API (sentence-chunked)
    const fallbackPlayed = await speakWithWebSpeechFallback(clean, {
      personaId: p.id,
      lang,
      token,
      onStart,
      onEnd: doneEnd,
    });
    doneEnd();
    return fallbackPlayed;
  } finally {
    doneEnd();
  }
}

export function stopCoachSpeech() {
  currentPlayToken++;
  if (activeAudioFinish) {
    try { activeAudioFinish(false); } catch { /* ignore */ }
  }
  try {
    if (sharedAudio) {
      sharedAudio.pause();
      sharedAudio.currentTime = 0;
    }
  } catch { /* ignore */ }
  try {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  } catch { /* ignore */ }
}

/**
 * Compact interactive pill showing current Coach Persona, clickable to switch.
 */
export function personaSwitchPill({ onSwitched, compact = false } = {}) {
  const lang = getLang();
  const p = getPersona(getPersonaId(), lang);
  return el("button", {
    type: "button",
    class: `persona-pill ${p.accentClass}${compact ? " is-compact" : ""}`,
    title: lang === "zh" ? "点击切换 AI 教练性格与风格" : "Switch AI Coach Persona",
    onmouseenter: () => prefetchPersonaSamples(lang),
    onclick: () => {
      unlockCoachAudio();
      openPersonaSelectorModal({ onSwitched });
    },
  }, [
    el("span", { class: "persona-avatar-mini", text: p.avatarText }),
    el("span", { class: "persona-pill-name", text: compact ? p.copy.shortName : p.copy.name }),
    icon("swap-horiz", { cls: "persona-pill-icon" }),
  ]);
}

/**
 * Renders the 3-card Coach Persona selector grid (used in both the Settings page
 * and the quick-switch modal).
 */
export function renderPersonaSelectorGrid({ onSwitched } = {}) {
  const lang = getLang();
  const isZh = lang === "zh";
  let currentId = getPersonaId();
  let playingPersonaId = null;

  prefetchPersonaSamples(lang);
  const container = el("div", { class: "persona-grid" });

  const renderCards = () => {
    currentId = getPersonaId();
    container.replaceChildren(...PERSONAS.map((raw) => {
      const p = getPersona(raw.id, lang);
      const active = p.id === currentId;
      const isPlaying = playingPersonaId === p.id;
      const previewBtn = el("button", {
        type: "button",
        class: `btn ${isPlaying ? "btn-primary" : "btn-outline"} btn-sm persona-preview-btn${isPlaying ? " is-playing" : ""}`,
        onclick: async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (playingPersonaId === p.id) {
            playingPersonaId = null;
            stopCoachSpeech();
            renderCards();
            return;
          }
          playingPersonaId = p.id;
          renderCards();
          await playStaticPersonaSample(p.id, lang, {
            onEnd: () => {
              if (playingPersonaId === p.id) {
                playingPersonaId = null;
                renderCards();
              }
            },
          });
        },
      }, [
        icon(isPlaying ? "pause" : "volume-up"),
        isPlaying
          ? (isZh ? "正在播报语音… (点击停止)" : "Playing Voice… (Tap to Stop)")
          : (isZh ? "试听教练语音" : "Preview Voice"),
      ]);

      const selectCard = () => {
        unlockCoachAudio();
        currentId = setPersonaId(p.id);
        renderCards();
        showToast(isZh ? `已切换为「${p.copy.name}」` : `Switched to ${p.copy.name}`);
        if (onSwitched) onSwitched(currentId);
      };

      return el("article", {
        class: `persona-card ${p.accentClass}${active ? " is-active" : ""}`,
        tabindex: "0",
        onclick: (e) => {
          if (e.target && e.target.closest && e.target.closest(".persona-preview-btn")) return;
          selectCard();
        },
        onkeydown: (e) => {
          if (e.target && e.target.closest && e.target.closest(".persona-preview-btn")) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectCard();
          }
        },
      }, [
        el("div", { class: "persona-card-head" }, [
          coachAvatar(p.id, { size: "lg", online: active }),
          el("div", { class: "persona-head-text" }, [
            el("div", { class: "persona-title-row" }, [
              el("h4", { text: p.copy.name }),
              active
                ? el("span", { class: "pill pill-primary persona-active-tag" }, [icon("check"), isZh ? "当前使用" : "Active"])
                : el("span", { class: "pill pill-outline persona-select-tag", text: isZh ? "点击启用" : "Select" }),
            ]),
            el("p", { class: "persona-gender muted small", text: p.copy.genderTag }),
          ]),
        ]),
        el("p", { class: "persona-style-title", text: p.copy.styleTitle }),
        el("div", { class: "persona-tags" }, p.copy.tags.map((tag) =>
          el("span", { class: "tag", text: tag })
        )),
        el("p", { class: "persona-bio muted small", text: p.copy.bio }),
        el("blockquote", { class: "persona-quote", text: p.copy.quote }),
        el("div", { class: "persona-card-foot" }, [previewBtn]),
      ]);
    }));
  };

  renderCards();
  return container;
}

/**
 * Opens the modal allowing the user to compare, preview voice, and select one
 * of the 3 Coach Personas.
 */
export function openPersonaSelectorModal({ onSwitched } = {}) {
  const lang = getLang();
  const isZh = lang === "zh";
  const listWrap = renderPersonaSelectorGrid({ onSwitched });

  const dialog = el("div", {
    class: "modal-card persona-modal",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "persona-modal-title",
  }, [
    el("header", { class: "modal-head" }, [
      el("div", {}, [
        el("p", { class: "eyebrow accent", text: isZh ? "个性化 AI 教练" : "PERSONALIZED AI COACH" }),
        el("h3", { id: "persona-modal-title", text: isZh ? "选择你的专属教练风格 (Persona)" : "Choose Your Coach Persona" }),
      ]),
      el("button", {
        type: "button",
        class: "icon-btn",
        "aria-label": isZh ? "关闭" : "Close",
        onclick: () => { stopCoachSpeech(); closeModal(); },
      }, [icon("close")]),
    ]),
    el("div", { class: "persona-modal-body" }, [
      el("p", {
        class: "muted small",
        text: isZh
          ? "不同教练拥有截然不同的性格、性别、沟通语气与高拟真神经网络语音声线。切换后将在「教练对话」、「每日微课堂」和「摄像头实时动作伴练」中全局生效。"
          : "Each coach brings a distinct personality, gender, communication tone, and neural voice coaching style across Chat, Daily Science Tips, and Live Form Coach.",
      }),
      listWrap,
    ]),
  ]);

  openModal(dialog);
}
