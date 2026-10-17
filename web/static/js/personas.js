// Coach Persona system: 3 selectable coaching personalities with distinct
// gender, tone, visual identity, and Web Speech TTS voice tuning.
import { el, icon } from "./util.js";
import { getLang } from "./i18n.js";
import { openModal, closeModal, showToast } from "./modal.js";
import { track } from "./telemetry.js";

const STORAGE_KEY = "fb_coach_persona_v1";
const DEFAULT_PERSONA_ID = "iron_leo";
const listeners = new Set();

export const PERSONAS = [
  {
    id: "iron_leo",
    icon: "fitness-center",
    avatarText: "LEO",
    accentClass: "persona-leo",
    gender: "male",
    voice: { pitch: 0.88, rate: 1.06, voiceHints: ["Male", "Daniel", "Alex", "Reed", "Eddy", "Yunxi", "Kangkang"] },
    zh: {
      name: "雷奥教练 · Coach Leo",
      shortName: "雷奥教练",
      genderTag: "♂ 男 · 硬核铁血主教练",
      styleTitle: "高能热血 · 渐进超负荷 · 严抠动作执行",
      tags: ["力量突破", "干脆利落", "拒绝借口"],
      bio: "前竞技体能主教练，崇尚有效训练容量与标准动作纪律。说话直接有力，在你想偷懒的最后两下给你最猛的推力，同时死守关节安全底线。",
      quote: "「核心绷紧！别跟重量讨价还价，高质量完成这一组，我替你盯紧每一度关节轨迹！」",
      sampleTts: "我是雷奥教练！今天我们不整虚的，核心绷紧，每一组都拿出身体的最佳状态，准备好了就开练！",
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
      sampleTts: "I'm Coach Leo! Lock in your focus, brace your core, and let's make every single rep count today!",
      tipPrefix: "Coach Leo's Take:",
    },
  },
  {
    id: "warm_maya",
    icon: "favorite",
    avatarText: "MAYA",
    accentClass: "persona-maya",
    gender: "female",
    voice: { pitch: 1.12, rate: 1.0, voiceHints: ["Female", "Samantha", "Tingting", "Xiaoxiao", "Mei-Jia", "Victoria", "Karen"] },
    zh: {
      name: "林悦教练 · Coach Maya",
      shortName: "林悦教练",
      genderTag: "♀ 女 · 温柔共情身心教练",
      styleTitle: "温暖治愈 · 可持续习惯 · 零焦虑陪伴",
      tags: ["温柔鼓励", "外食友好", "倾听身体"],
      bio: "专注女性与大众可持续体态管理、运动营养与反焦虑饮食。永远先看见你的努力与进步，帮你把健康融入生活，而不是让训练变成压力。",
      quote: "「哪怕今天只完成了 20 分钟，也是对身体超棒的投资～放轻松，我们一步步稳稳变强！」",
      sampleTts: "嗨，我是林悦教练～不用给自己太大压力，今天我们依然顺着身体的节奏，开心地动起来吧！",
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
      sampleTts: "Hi there, I'm Coach Maya! Take a deep breath—let's listen to your body and enjoy a great session together.",
      tipPrefix: "Coach Maya's Note:",
    },
  },
  {
    id: "science_dr_chen",
    icon: "psychology",
    avatarText: "CHEN",
    accentClass: "persona-chen",
    gender: "neutral",
    voice: { pitch: 0.98, rate: 1.03, voiceHints: ["Sin-ji", "Aaron", "Arthur", "Daniel", "Tingting"] },
    zh: {
      name: "陈博士 · Dr. Alex Chen",
      shortName: "陈博士",
      genderTag: "⚧ 运动生理学与营养学博士",
      styleTitle: "循证科学 · 生物力学拆解 · 数据驱动",
      tags: ["运动生物力学", "代谢机制", "精准量化"],
      bio: "运动人体科学实验室出身，擅长用第一性原理拆解力臂、肌纤维募集、RPE 与营养代谢，让你不仅练对动作，更彻底搞懂背后的科学逻辑。",
      quote: "「将离心阶段控制在 2.5 秒可显著提升机械张力；我们用数据说话，精准优化你的每一卡路里。」",
      sampleTts: "你好，我是陈博士。今天我们将结合运动生物力学与能量代谢数据，精准优化你的训练与营养方案。",
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

/**
 * Speaks coaching text using Web Speech API tuned to the persona's gender/style.
 */
export function speakCoachText(text, { personaId = getPersonaId(), lang = getLang(), onStart, onEnd } = {}) {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text) {
    if (onEnd) onEnd();
    return false;
  }
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const p = getPersona(personaId, lang);
    const utter = new SpeechSynthesisUtterance(String(text));
    const targetLang = lang === "zh" ? "zh-CN" : "en-US";
    utter.lang = targetLang;
    utter.pitch = p.voice.pitch || 1.0;
    utter.rate = p.voice.rate || 1.0;

    const voices = synth.getVoices ? synth.getVoices() : [];
    const langVoices = voices.filter((v) =>
      String(v.lang || "").toLowerCase().startsWith(lang === "zh" ? "zh" : "en")
    );
    if (langVoices.length) {
      const hints = p.voice.voiceHints || [];
      let picked = null;
      for (const h of hints) {
        picked = langVoices.find((v) => String(v.name || "").toLowerCase().includes(h.toLowerCase()));
        if (picked) break;
      }
      utter.voice = picked || langVoices[0];
    }
    if (onStart) utter.onstart = onStart;
    if (onEnd) {
      utter.onend = onEnd;
      utter.onerror = onEnd;
    }
    synth.speak(utter);
    return true;
  } catch {
    if (onEnd) onEnd();
    return false;
  }
}

export function stopCoachSpeech() {
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
    onclick: () => openPersonaSelectorModal({ onSwitched }),
  }, [
    el("span", { class: "persona-avatar-mini", text: p.avatarText }),
    el("span", { class: "persona-pill-name", text: compact ? p.copy.shortName : p.copy.name }),
    icon("swap-horiz", { cls: "persona-pill-icon" }),
  ]);
}

/**
 * Opens the modal allowing the user to compare, preview voice, and select one
 * of the 3 Coach Personas.
 */
export function openPersonaSelectorModal({ onSwitched } = {}) {
  const lang = getLang();
  const isZh = lang === "zh";
  let currentId = getPersonaId();

  const renderCards = (container) => {
    container.replaceChildren(...PERSONAS.map((raw) => {
      const p = getPersona(raw.id, lang);
      const active = p.id === currentId;
      return el("div", {
        class: `persona-card ${p.accentClass}${active ? " is-active" : ""}`,
        role: "button",
        tabindex: "0",
        onclick: (e) => {
          if (e.target.closest(".persona-preview-btn")) return;
          currentId = setPersonaId(p.id);
          renderCards(container);
          showToast(isZh ? `已切换为「${p.copy.name}」` : `Switched to ${p.copy.name}`);
          if (onSwitched) onSwitched(currentId);
        },
        onkeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            currentId = setPersonaId(p.id);
            renderCards(container);
            showToast(isZh ? `已切换为「${p.copy.name}」` : `Switched to ${p.copy.name}`);
            if (onSwitched) onSwitched(currentId);
          }
        },
      }, [
        el("div", { class: "persona-card-head" }, [
          el("div", { class: "persona-avatar-badge" }, [
            icon(p.icon),
            el("span", { text: p.avatarText }),
          ]),
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
        el("div", { class: "persona-card-foot" }, [
          el("button", {
            type: "button",
            class: "btn btn-outline btn-sm persona-preview-btn",
            onclick: (e) => {
              e.stopPropagation();
              speakCoachText(p.copy.sampleTts, { personaId: p.id, lang });
            },
          }, [icon("volume-up"), isZh ? "试听教练语音" : "Preview Voice"]),
        ]),
      ]);
    }));
  };

  const listWrap = el("div", { class: "persona-grid" });
  renderCards(listWrap);

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
          ? "不同教练拥有截然不同的性格、性别、沟通语气与实时语音指导声线。切换后将在「教练对话」、「每日微课堂」和「摄像头实时动作伴练」中全局生效。"
          : "Each coach brings a distinct personality, gender, communication tone, and live voice coaching style across Chat, Daily Science Tips, and Live Form Coach.",
      }),
      listWrap,
    ]),
  ]);

  openModal(dialog);
}
