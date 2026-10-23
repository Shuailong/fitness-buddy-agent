// Exercise Form Guide (Biomechanical SVG Animation + Cues + Mistakes)
// and Live Camera AI Form Coach with Real-Time Voice Feedback (TTS).
import { el, icon } from "./util.js";
import { getLang, t, translate } from "./i18n.js";
import { openModal, closeModal, showToast } from "./modal.js";
import { getPersona, getPersonaId, speakCoachText, stopCoachSpeech, unlockCoachAudio, personaSwitchPill } from "./personas.js";
import { track } from "./telemetry.js";
import { GUIDE_BOOK } from "./exercise-guides-data.js";
import { computePose } from "./exercise-poses.js";

// Per-exercise guides are curated in web/data/exercise_guides.json (one entry
// per library exercise) and shipped as a generated module. Names are matched
// with the same rule as the server (web/exercise_guides.py normalize_name).
const GUIDES = GUIDE_BOOK.guides;
const NAME_INDEX = GUIDE_BOOK.index;

// Localized exercise names for the 50-exercise catalog (kept for callers).
export const EXERCISE_NAMES_ZH = Object.fromEntries(
  Object.values(GUIDES).map((g) => [g.id, g.names.zh]),
);

export function normalizeExerciseName(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[(（[【].*?[)）\]】]/g, " ")
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
}

const minContainedLen = (key) => (/[\u4e00-\u9fff]/.test(key) ? 2 : 5);

/** Library id or free-text name -> guide id (null = not in the catalog). */
export function resolveExerciseId(exOrId) {
  const rawId = typeof exOrId === "string" ? exOrId : (exOrId && (exOrId.exercise_id || exOrId.id)) || "";
  const name = typeof exOrId === "object" && exOrId ? (exOrId.name || "") : "";
  const eid = String(rawId).trim().toLowerCase();
  if (GUIDES[eid]) return eid;
  for (const probe of [eid, name]) {
    const norm = normalizeExerciseName(probe);
    if (norm && NAME_INDEX[norm]) return NAME_INDEX[norm];
  }
  for (const probe of [name, eid]) {
    const norm = normalizeExerciseName(probe);
    if (!norm) continue;
    let best = null;
    for (const [key, gid] of Object.entries(NAME_INDEX)) {
      if (key.length >= minContainedLen(key) && norm.includes(key) && (!best || key.length > best[0])) {
        best = [key.length, gid];
      }
    }
    if (best) return best[1];
  }
  return null;
}

/** Movement pattern used for the animation (kept under its old name). */
export function resolveExerciseArchetype(exOrId) {
  const gid = resolveExerciseId(exOrId);
  return gid ? GUIDES[gid].pattern : "generic";
}

function genericCopy(lang) {
  const tr = (k) => translate(lang, `exercises.generic.${k}`);
  return {
    tempo: tr("tempo"),
    breathing: tr("breathing"),
    cues: [1, 2, 3].map((n) => ({ title: tr(`cue${n}Title`), text: tr(`cue${n}Text`) })),
    mistakes: [1, 2].map((n) => ({ bad: tr(`mistake${n}Bad`), fix: tr(`mistake${n}Fix`) })),
    safety: tr("safety"),
  };
}

export function getExerciseGuide(exOrId, lang = getLang()) {
  const L = translate(lang, "meta.langCode") === "zh" ? "zh" : "en";
  const rawId = typeof exOrId === "string"
    ? exOrId
    : (exOrId && (exOrId.exercise_id || exOrId.id)) || "";
  const rawName = (typeof exOrId === "object" && exOrId ? exOrId.name : "") || "";
  const gid = resolveExerciseId(exOrId);
  const g = gid ? GUIDES[gid] : null;

  if (!g) {
    const label = rawName || String(rawId || "").replace(/_/g, " ");
    const copy = genericCopy(L);
    return {
      id: rawId || label.toLowerCase().replace(/\s+/g, "_"),
      known: false,
      rawName: label,
      zhName: label,
      displayName: label,
      subtitle: "",
      archetype: "generic",
      motion: "hold",
      phaseOrder: "lower_first",
      tempo: copy.tempo,
      muscles: [],
      breathing: copy.breathing,
      cues: copy.cues,
      mistakes: copy.mistakes,
      safety: copy.safety,
      easier: "",
      harder: "",
      videoUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(`${label} exercise proper form`)}`,
    };
  }

  // The plan may carry its own wording (another language, or a variation such
  // as "暂停高脚杯深蹲"): show the catalog name, plus the plan's wording when it
  // says something different.
  const norm = normalizeExerciseName(rawName);
  // "高脚杯深蹲 (Goblet Squat)": either the text or its bracketed part may be
  // the catalog wording.
  const bracketed = [...String(rawName).matchAll(/[(（[【](.*?)[)）\]】]/g)].map((m) => normalizeExerciseName(m[1]));
  const sameAsCatalog = !norm || [norm, ...bracketed].some((n) => NAME_INDEX[n] === g.id);
  const muscleLabel = (k) => (GUIDE_BOOK.muscles[k] ? GUIDE_BOOK.muscles[k][L] : k);
  return {
    id: g.id,
    known: true,
    rawName: g.names.en,
    zhName: g.names.zh,
    displayName: g.names[L],
    subtitle: sameAsCatalog ? "" : rawName,
    archetype: g.pattern,
    motion: g.motion,
    phaseOrder: g.phase_order || "lower_first",
    tempo: g.tempo[L],
    muscles: [...g.muscles.primary, ...g.muscles.secondary].map(muscleLabel),
    primaryMuscles: g.muscles.primary.map(muscleLabel),
    breathing: g.breathing[L],
    cues: g.cues.map((c) => c[L]),
    mistakes: g.mistakes.map((m) => m[L]),
    safety: g.safety[L],
    easier: g.easier[L],
    harder: g.harder[L],
    videoUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(g.video_query)}`,
  };
}

// Cycle length (ms at 1x) for continuous cardio patterns.
const CYCLE_MS = { run: 900, jump_rope: 700, walk: 1300, incline_walk: 1500, bike: 1100, rowing_machine: 2600, march: 1400 };

/** Maps elapsed cycle fraction -> pose phase t and the HUD label key. */
function phaseFor(guide, elapsed) {
  const ease = (p) => 0.5 - 0.5 * Math.cos(Math.PI * p);
  if (guide.motion === "cyclic") return { t: elapsed, key: "exercises.phase.rhythm" };
  if (guide.motion === "hold") return { t: ease(elapsed < 0.5 ? elapsed * 2 : 2 - elapsed * 2), key: "exercises.phase.hold" };
  if (guide.motion === "stretch") {
    if (elapsed < 0.35) return { t: ease(elapsed / 0.35), key: "exercises.phase.stretchIn" };
    if (elapsed < 0.65) return { t: 1, key: "exercises.phase.stretchHold" };
    if (elapsed < 0.95) return { t: 1 - ease((elapsed - 0.65) / 0.3), key: "exercises.phase.stretchOut" };
    return { t: 0, key: "exercises.phase.stretchOut" };
  }
  const lift = guide.phaseOrder === "lift_first";
  if (elapsed < 0.42) return { t: ease(elapsed / 0.42), key: lift ? "exercises.phase.exhaleLift" : "exercises.phase.inhaleLower" };
  if (elapsed < 0.55) return { t: 1, key: lift ? "exercises.phase.peakSqueeze" : "exercises.phase.holdBottom" };
  if (elapsed < 0.92) return { t: 1 - ease((elapsed - 0.55) / 0.37), key: lift ? "exercises.phase.inhaleReturn" : "exercises.phase.exhaleDrive" };
  return { t: 0, key: "exercises.phase.setup" };
}

function cycleMs(guide) {
  if (guide.motion === "cyclic") return CYCLE_MS[guide.archetype] || 1400;
  if (guide.motion === "hold") return 4000;
  if (guide.motion === "stretch") return 7000;
  return guide.archetype === "swing" ? 1700 : 4200;
}

const pathOf = (...pts) => pts.filter(Boolean).map((p, i) => `${i ? "L" : "M"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");

/**
 * Creates an interactive SVG biomechanical animation stage for an exercise.
 */
export function createExerciseAnimStage(guide, { lang = getLang() } = {}) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 360 210");
  svg.setAttribute("class", "ex-anim-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", guide.displayName);

  const mk = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  const floor = mk("line", { x1: 36, y1: 186, x2: 324, y2: 186, class: "ex-svg-floor" });
  svg.append(floor, mk("line", { x1: 180, y1: 18, x2: 180, y2: 186, class: "ex-svg-axis" }));

  const equipBack = mk("g", { class: "ex-svg-equip" });
  const backLimb = mk("path", { class: "ex-svg-limb-back" });
  const backArm = mk("path", { class: "ex-svg-arm-back" });
  const bodyPath = mk("path", { class: "ex-svg-body" });
  const armPath = mk("path", { class: "ex-svg-arm" });
  const headCircle = mk("circle", { r: 11, class: "ex-svg-head" });
  const equipFront = mk("g", { class: "ex-svg-equip" });
  const muscleGroup = mk("g", { class: "ex-svg-muscles" });
  const jointGroup = mk("g", { class: "ex-svg-joints" });
  svg.append(equipBack, backLimb, backArm, bodyPath, armPath, headCircle, equipFront, muscleGroup, jointGroup);

  const phaseBadge = el("span", { class: "ex-anim-phase-pill" });
  const musclesLine = guide.muscles.length
    ? el("div", { class: "ex-anim-muscles" }, [
      el("span", { class: "muted small", text: translate(lang, "exercises.targetMuscles") }),
      ...guide.muscles.map((m, i) => el("span", {
        class: `pill ${i < (guide.primaryMuscles || guide.muscles).length ? "pill-primary" : ""} ex-muscle-tag`,
        text: m,
      })),
    ])
    : null;

  let speed = 1.0;
  let paused = false;
  const startTs = performance.now();

  const speedBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: () => {
      speed = speed === 1.0 ? 0.5 : 1.0;
      speedBtn.textContent = speed === 1.0 ? (translate(lang, "exercises.10xSpeed")) : (translate(lang, "exercises.05xSlowMo"));
    },
  }, [translate(lang, "exercises.10xSpeed")]);

  const pauseBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: () => {
      paused = !paused;
      pauseBtn.textContent = paused ? (translate(lang, "exercises.play")) : (translate(lang, "exercises.pause"));
    },
  }, [translate(lang, "exercises.pause")]);

  const drawEquip = (item) => {
    switch (item.kind) {
      case "weight": return mk("circle", { cx: item.at[0], cy: item.at[1], r: item.r || 7, class: "ex-svg-weight" });
      case "kb": {
        const g = mk("g");
        g.append(
          mk("circle", { cx: item.at[0], cy: item.at[1] + 7, r: 8, class: "ex-svg-weight" }),
          mk("circle", { cx: item.at[0], cy: item.at[1], r: 4, class: "ex-svg-kb-handle" }),
        );
        return g;
      }
      case "line": return mk("line", { x1: item.a[0], y1: item.a[1], x2: item.b[0], y2: item.b[1], class: `ex-svg-${item.cls || "bar"}` });
      case "rect": return mk("rect", { x: item.x, y: item.y, width: item.w, height: item.h, rx: 3, class: "ex-svg-bench" });
      case "ring": return mk("circle", { cx: item.at[0], cy: item.at[1], r: item.r, class: "ex-svg-ring" });
      case "path": return mk("path", { d: item.d, class: `ex-svg-${item.cls || "band"}` });
      default: return null;
    }
  };

  const renderFrame = (now) => {
    const ms = cycleMs(guide) / speed;
    const elapsed = ((now - startTs) % ms) / ms;
    const { t, key } = phaseFor(guide, elapsed);
    phaseBadge.textContent = translate(lang, key);

    const pose = computePose(guide.archetype, t);
    floor.style.display = pose.noFloor ? "none" : "";
    headCircle.setAttribute("cx", pose.head[0].toFixed(1));
    headCircle.setAttribute("cy", pose.head[1].toFixed(1));

    if (pose.frontal) {
      bodyPath.setAttribute("d", [
        pathOf(pose.shoulderL, pose.shoulderR),
        pathOf(pose.shoulder, pose.hip),
        pathOf(pose.hipL, pose.hipR),
        pathOf(pose.hipR, pose.knee, pose.ankle, pose.foot),
      ].join(" "));
      backLimb.setAttribute("d", pathOf(pose.hipL, pose.backKnee, pose.backAnkle, pose.backFoot));
      armPath.setAttribute("d", pathOf(pose.shoulderR, pose.elbow, pose.hand));
      backArm.setAttribute("d", pathOf(pose.shoulderL, pose.backElbow, pose.backHand));
    } else {
      let spine = pathOf(pose.shoulder, pose.hip);
      if (pose.spineBend) {
        // Curved back (cat / cow): control point pushed off the spine line.
        const [sx, sy] = pose.shoulder;
        const [hx, hy] = pose.hip;
        const len = Math.hypot(hx - sx, hy - sy) || 1;
        const cx = (sx + hx) / 2 + ((hy - sy) / len) * pose.spineBend;
        const cy = (sy + hy) / 2 - ((hx - sx) / len) * pose.spineBend;
        spine = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${hx.toFixed(1)} ${hy.toFixed(1)}`;
      }
      bodyPath.setAttribute("d", `${spine} ${pathOf(pose.hip, pose.knee, pose.ankle, pose.foot).replace(/^M/, "L")}`);
      backLimb.setAttribute("d", pose.backKnee ? pathOf(pose.hip, pose.backKnee, pose.backAnkle, pose.backFoot) : "");
      armPath.setAttribute("d", pathOf(pose.shoulder, pose.elbow, pose.hand));
      backArm.setAttribute("d", pose.backElbow ? pathOf(pose.shoulder, pose.backElbow, pose.backHand) : "");
    }

    muscleGroup.replaceChildren(...pose.muscles.map(([mx, my]) =>
      mk("circle", {
        cx: mx.toFixed(1),
        cy: my.toFixed(1),
        r: (7 + 4 * t).toFixed(1),
        class: "ex-svg-muscle-glow",
        style: `opacity: ${(0.35 + 0.55 * (guide.motion === "cyclic" ? 0.6 : t)).toFixed(2)}`,
      }),
    ));

    const joints = pose.frontal
      ? [pose.shoulderR, pose.shoulderL, pose.elbow, pose.backElbow, pose.knee, pose.backKnee]
      : [pose.shoulder, pose.hip, pose.knee, pose.elbow];
    jointGroup.replaceChildren(...joints.filter(Boolean).map(([jx, jy]) =>
      mk("circle", { cx: jx.toFixed(1), cy: jy.toFixed(1), r: 4, class: "ex-svg-joint" }),
    ));

    const front = pose.equip.filter((e) => e.kind === "weight" || e.kind === "kb");
    const back = pose.equip.filter((e) => !(e.kind === "weight" || e.kind === "kb"));
    equipBack.replaceChildren(...back.map(drawEquip).filter(Boolean));
    equipFront.replaceChildren(...front.map(drawEquip).filter(Boolean));
  };

  renderFrame(performance.now());
  if (typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    requestAnimationFrame(function tick(ts) {
      if (!paused) renderFrame(ts);
      if (document.body.contains(svg)) requestAnimationFrame(tick);
    });
  }

  return el("div", { class: "ex-anim-stage-wrap" }, [
    el("div", { class: "ex-anim-stage" }, [
      el("div", { class: "ex-anim-top-hud" }, [
        phaseBadge,
        el("span", { class: "ex-anim-tempo-tag", text: `⏱ ${guide.tempo}` }),
      ]),
      svg,
      el("div", { class: "ex-anim-controls" }, [speedBtn, pauseBtn]),
    ]),
    musclesLine,
  ].filter(Boolean));
}

/**
 * Opens the Exercise Form Guide Modal (Biomechanical Animation + Cues + Mistakes + Video + Live Camera CTA).
 */
export function openExerciseDetailModal(exOrId, actions) {
  const lang = getLang();
  const isZh = lang === "zh";
  const guide = getExerciseGuide(exOrId, lang);
  track("exercise_guide", { exercise_id: guide.id });

  const dialog = el("div", {
    class: "modal-card ex-detail-modal",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "ex-detail-title",
  }, [
    el("header", { class: "modal-head" }, [
      el("div", {}, [
        el("p", { class: "eyebrow accent", text: translate(lang, "exercises.biomechanicsFormGuide") }),
        el("h3", { id: "ex-detail-title", text: guide.displayName }),
        guide.subtitle ? el("p", { class: "muted small ex-detail-subtitle", text: guide.subtitle }) : null,
      ]),
      el("button", {
        type: "button",
        class: "icon-btn",
        "aria-label": translate(lang, "exercises.close"),
        onclick: closeModal,
      }, [icon("close")]),
    ]),
    el("div", { class: "ex-detail-body" }, [
      guide.known ? null : el("p", { class: "ex-generic-notice small", text: translate(lang, "exercises.genericNotice") }),
      // Built-in biomechanical animation stage
      createExerciseAnimStage(guide, { lang }),

      // Primary Hero CTA: Open Live Camera AI Form Coach with Voice Feedback
      el("div", { class: "ex-live-cta-banner" }, [
        el("div", { class: "ex-live-cta-text" }, [
          el("strong", { text: translate(lang, "exercises.liveAiCameraFormVoice") }),
          el("p", {
            class: "muted small",
            text: translate(lang, "exercises.turnOnYourCameraFor"),
          }),
        ]),
        el("button", {
          type: "button",
          class: "btn btn-primary ex-live-start-btn",
          onclick: () => {
            unlockCoachAudio();
            closeModal();
            openLiveFormCoachModal(exOrId, actions);
          },
        }, [icon("videocam"), translate(lang, "exercises.startLiveCameraCoach")]),
      ]),

      // 3-step form cues
      el("div", { class: "ex-cues-section" }, [
        el("h4", { class: "ex-sec-title", text: translate(lang, "exercises.stepByStepFormCues") }),
        el("ol", { class: "ex-cue-list" }, guide.cues.map((c, idx) =>
          el("li", { class: "ex-cue-item" }, [
            el("span", { class: "num", text: String(idx + 1) }),
            el("div", {}, [
              el("strong", { text: c.title }),
              el("p", { class: "muted small", text: c.text }),
            ]),
          ])
        )),
      ]),

      // Breathing rule
      el("div", { class: "ex-breath-box" }, [
        icon("air", { cls: "accent" }),
        el("div", {}, [
          el("strong", { text: translate(lang, "exercises.breathingTempo") }),
          el("span", { class: "small", text: guide.breathing }),
        ]),
      ]),

      // Common mistakes & fixes
      el("div", { class: "ex-mistakes-section" }, [
        el("h4", { class: "ex-sec-title", text: translate(lang, "exercises.commonMistakesFixes") }),
        el("div", { class: "ex-mistake-list" }, guide.mistakes.map((m) =>
          el("div", { class: "ex-mistake-card" }, [
            el("p", { class: "ex-mistake-bad" }, [el("span", { text: "❌ " }), el("strong", { text: m.bad })]),
            el("p", { class: "ex-mistake-fix small" }, [el("span", { text: "✅ " }), el("span", { text: m.fix })]),
          ])
        )),
      ]),

      // Make it easier / harder
      guide.easier || guide.harder ? el("div", { class: "ex-difficulty-section" }, [
        el("h4", { class: "ex-sec-title", text: translate(lang, "exercises.adjustDifficulty") }),
        el("div", { class: "ex-difficulty-list" }, [
          guide.easier ? el("p", { class: "small" }, [el("strong", { text: `${translate(lang, "exercises.easierLabel")} · ` }), el("span", { text: guide.easier })]) : null,
          guide.harder ? el("p", { class: "small" }, [el("strong", { text: `${translate(lang, "exercises.harderLabel")} · ` }), el("span", { text: guide.harder })]) : null,
        ]),
      ]) : null,

      // Safety note
      guide.safety ? el("div", { class: "ex-safety-box" }, [
        icon("health-and-safety", { cls: "accent" }),
        el("div", {}, [
          el("strong", { text: translate(lang, "exercises.safetyTitle") }),
          el("span", { class: "small", text: guide.safety }),
        ]),
      ]) : null,

      // Footer links: Watch HD Real-Person Video + Ask Coach to substitute
      el("div", { class: "ex-detail-actions" }, [
        el("a", {
          href: guide.videoUrl,
          target: "_blank",
          rel: "noopener noreferrer",
          class: "btn btn-outline btn-sm",
        }, [icon("play-circle"), translate(lang, "exercises.watchHdVideoTutorial")]),
        el("button", {
          type: "button",
          class: "btn btn-outline btn-sm",
          onclick: () => {
            closeModal();
            if (actions && actions.openCoach) {
              actions.openCoach({
                send: translate(lang, "exercises.askFormTips", { name: isZh ? guide.zhName : guide.rawName }),
              });
            }
          },
        }, [icon("smart-toy"), translate(lang, "exercises.askCoachSwapExercise")]),
      ]),
    ]),
  ]);

  openModal(dialog);
}

/**
 * Inspects a 2D canvas frame for brightness & contrast so covered lenses or
 * blank walls are detected immediately instead of hallucinating form scores.
 */
function inspectCanvasFrameStats(ctx, width, height) {
  try {
    const data = ctx.getImageData(0, 0, width, height).data;
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    // Sample every 16th pixel for speed
    const step = 16 * 4;
    for (let i = 0; i < data.length; i += step) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
      count++;
    }
    if (!count) return "camera";
    const mean = sum / count;
    const variance = Math.max(0, sumSq / count - mean * mean);
    const std = Math.sqrt(variance);
    if (mean < 14 && std < 9) return "dark";
    if (std < 5.5) return "blank";
    return "camera";
  } catch {
    return "camera";
  }
}

/**
 * Opens the Live Camera AI Form Coach Studio with real-time frame capture,
 * strict evidence verification, biomechanical HUD overlay, and neural TTS voice feedback.
 */
export function openLiveFormCoachModal(exOrId, actions) {
  if (actions && actions.isDemo && actions.isDemo()) {
    // Live camera coaching is the most expensive feature: signed-in accounts only.
    showToast(t("exercises.liveCameraCoachingNeedsA"), { iconName: "lock" });
    return;
  }
  // Synchronously unlock browser audio inside the user click gesture!
  unlockCoachAudio();

  const lang = getLang();
  const isZh = lang === "zh";
  const guide = getExerciseGuide(exOrId, lang);
  track("form_check", { action: "open_studio", exercise_id: guide.id });

  let stream = null;
  let loopTimerId = null;
  let isCoaching = false;
  let inFlight = false;
  let voiceEnabled = true;
  let facingMode = "user";
  let simulationMode = false;
  let frameIndex = 0;
  let repCount = 0;
  let lastScore = null;
  let lastSpokenCue = "";
  let lastSpokenAt = 0;
  let lastAudioB64 = null;
  let lastAudioMime = "audio/wav";

  const videoEl = el("video", {
    class: "live-coach-video is-mirrored",
    autoplay: "",
    playsinline: "",
    muted: "",
  });
  const captureCanvas = document.createElement("canvas");
  captureCanvas.width = 640;
  captureCanvas.height = 480;

  const statusBadge = el("span", {
    class: "live-hud-status waiting",
    text: translate(lang, "exercises.startingCameraStepBackInto"),
  });
  const scoreBadge = el("span", {
    class: "live-hud-score",
    text: translate(lang, "exercises.formScore"),
  });
  const repBadge = el("span", {
    class: "live-hud-reps",
    text: translate(lang, "exercises.reps0"),
  });

  const observedSceneBar = el("div", {
    class: "live-observed-scene",
    text: translate(lang, "exercises.strictAiVisionGateScores"),
  });

  const voiceTextEl = el("p", {
    class: "live-voice-text",
    text: translate(lang, "exercises.p0IsGettingReadyPlace", { p0: getPersona(getPersonaId(), lang).copy.shortName }),
  });

  const replayVoiceBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm live-replay-btn",
    title: translate(lang, "exercises.replayCurrentVoiceCue"),
    onclick: async () => {
      unlockCoachAudio();
      const textToSpeak = voiceTextEl.textContent || lastSpokenCue;
      if (!textToSpeak) return;
      voiceCueBanner.classList.add("is-speaking");
      await speakCoachText(textToSpeak, {
        personaId: getPersonaId(),
        lang,
        audioB64: lastAudioB64,
        audioMime: lastAudioMime,
      });
      voiceCueBanner.classList.remove("is-speaking");
    },
  }, [icon("volume-up"), translate(lang, "exercises.speak")]);

  const voiceCueBanner = el("div", { class: "live-voice-banner" }, [
    icon("volume-up", { cls: "accent live-voice-icon" }),
    voiceTextEl,
    replayVoiceBtn,
  ]);

  const checksWrap = el("div", { class: "live-checks-grid" }, [
    el("div", { class: "live-check-item" }, [
      el("span", { class: "muted small", text: translate(lang, "exercises.cameraFraming") }),
      el("strong", { text: translate(lang, "exercises.waiting") }),
    ]),
    el("div", { class: "live-check-item" }, [
      el("span", { class: "muted small", text: translate(lang, "exercises.jointTracking") }),
      el("strong", { text: translate(lang, "exercises.waiting") }),
    ]),
    el("div", { class: "live-check-item" }, [
      el("span", { class: "muted small", text: translate(lang, "exercises.depthTempo") }),
      el("strong", { text: translate(lang, "exercises.waiting") }),
    ]),
  ]);

  const simStageWrap = el("div", { class: "live-sim-fallback", hidden: true }, [
    createExerciseAnimStage(guide, { lang }),
  ]);

  const clearLoopTimer = () => {
    if (loopTimerId) {
      clearTimeout(loopTimerId);
      loopTimerId = null;
    }
  };

  let liveWs = null;
  let wsPendingHandler = null;

  const closeLiveWs = () => {
    wsPendingHandler = null;
    if (liveWs) {
      try {
        liveWs.onopen = null;
        liveWs.onmessage = null;
        liveWs.onerror = null;
        liveWs.onclose = null;
        liveWs.close();
      } catch { /* ignore */ }
      liveWs = null;
    }
  };

  const ensureLiveWs = () => new Promise((resolve) => {
    if (typeof WebSocket === "undefined" || typeof window === "undefined") {
      resolve(null);
      return;
    }
    if (liveWs && liveWs.readyState === WebSocket.OPEN) {
      resolve(liveWs);
      return;
    }
    closeLiveWs();
    let settled = false;
    const finish = (sock) => {
      if (settled) return;
      settled = true;
      resolve(sock);
    };
    const timer = setTimeout(() => finish(null), 2200);
    try {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/api/live-coach/ws`);
      liveWs = ws;
      ws.onopen = () => {
        clearTimeout(timer);
        finish(ws);
      };
      ws.onmessage = (evt) => {
        try {
          const msg = JSON.parse(evt.data);
          if (wsPendingHandler) wsPendingHandler(msg);
        } catch { /* ignore */ }
      };
      ws.onerror = () => {
        clearTimeout(timer);
        closeLiveWs();
        finish(null);
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (liveWs === ws) liveWs = null;
        finish(null);
      };
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });

  const stopAll = () => {
    isCoaching = false;
    clearLoopTimer();
    closeLiveWs();
    if (stream) {
      for (const trk of stream.getTracks()) {
        try { trk.stop(); } catch { /* ignore */ }
      }
      stream = null;
    }
    stopCoachSpeech();
  };

  const startCamera = async () => {
    try {
      if (stream) {
        for (const trk of stream.getTracks()) trk.stop();
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera API unavailable");
      }
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false,
      });
      videoEl.srcObject = stream;
      videoEl.classList.toggle("is-mirrored", facingMode === "user");
      videoEl.hidden = false;
      simStageWrap.hidden = true;
      simulationMode = false;
      await videoEl.play().catch(() => {});
      return true;
    } catch {
      // Do NOT silently fake scores when camera fails; inform user honestly!
      simulationMode = false;
      videoEl.hidden = true;
      simStageWrap.hidden = false;
      statusBadge.className = "live-hud-status insufficient";
      statusBadge.textContent = translate(lang, "exercises.cameraUnavailableAllowCameraOr");
      scoreBadge.textContent = translate(lang, "exercises.scoreNoVideo");
      observedSceneBar.textContent = translate(lang, "exercises.cameraPermissionDeniedOrUnavailable");
      return false;
    }
  };

  const captureFramePayload = () => new Promise((resolve) => {
    const ctx = captureCanvas.getContext("2d");
    if (!simulationMode) {
      if (!stream || videoEl.readyState < 2 || videoEl.videoWidth <= 0) {
        resolve({ blob: null, dataUrl: "", frameHint: "no_video" });
        return;
      }
      captureCanvas.width = 640;
      captureCanvas.height = Math.round((videoEl.videoHeight / videoEl.videoWidth) * 640) || 480;
      ctx.drawImage(videoEl, 0, 0, captureCanvas.width, captureCanvas.height);
      const frameHint = inspectCanvasFrameStats(ctx, captureCanvas.width, captureCanvas.height);
      const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.78);
      captureCanvas.toBlob((blob) => resolve({ blob, dataUrl, frameHint }), "image/jpeg", 0.78);
      return;
    }

    // Explicit Demo / Simulation mode requested by user
    captureCanvas.width = 640;
    captureCanvas.height = 480;
    ctx.fillStyle = "#0F172A";
    ctx.fillRect(0, 0, 640, 480);
    ctx.strokeStyle = "#10B981";
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(320, 110, 26, 0, Math.PI * 2);
    ctx.moveTo(320, 136);
    ctx.lineTo(310, 260);
    ctx.lineTo(350, 360);
    ctx.lineTo(340, 440);
    ctx.stroke();
    const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.72);
    captureCanvas.toBlob((blob) => resolve({ blob, dataUrl, frameHint: "simulation" }), "image/jpeg", 0.72);
  });

  const applyVisionHudUpdate = (res) => {
    const status = res.status || "insufficient_evidence";
    if (status === "daily_limit") {
      // Daily live-coach allowance used up: stop the loop and say so.
      statusBadge.className = "live-hud-status insufficient";
      statusBadge.textContent = translate(lang, "exercises.liveDailyLimit");
      voiceTextEl.textContent = translate(lang, "exercises.liveDailyLimitDetail");
      if (isCoaching) setCoachingState(false);
      return status;
    }
    const hasValidScore = typeof res.score === "number" && res.evidence_ok !== false && status !== "insufficient_evidence";

    if (!hasValidScore) {
      statusBadge.className = "live-hud-status insufficient";
      statusBadge.textContent = translate(lang, "exercises.insufficientViewAdjustCamera");
      scoreBadge.textContent = translate(lang, "exercises.scoreNotInFrame");
    } else {
      lastScore = res.score;
      if (res.rep_increment && Number(res.rep_increment) > 0) {
        repCount += Number(res.rep_increment);
      }
      statusBadge.className = `live-hud-status ${status}`;
      if (status === "good") {
        statusBadge.textContent = translate(lang, "exercises.greatFormKeepGoing");
      } else if (status === "bad") {
        statusBadge.textContent = translate(lang, "exercises.formBreakdownAdjustNow");
      } else {
        statusBadge.textContent = translate(lang, "exercises.formAdjustmentCue");
      }
      scoreBadge.textContent = translate(lang, "exercises.scoreP0", { p0: lastScore });
    }
    repBadge.textContent = translate(lang, "exercises.repsP0", { p0: repCount });

    if (res.observed_scene) {
      observedSceneBar.textContent = translate(lang, "exercises.aiObservedP0", { p0: res.observed_scene });
    }

    if (res.voice_cue) {
      voiceTextEl.textContent = res.voice_cue;
      voiceCueBanner.classList.remove("pulse");
      void voiceCueBanner.offsetWidth;
      voiceCueBanner.classList.add("pulse");
    }

    if (Array.isArray(res.checks) && res.checks.length) {
      checksWrap.replaceChildren(...res.checks.map((chk) =>
        el("div", { class: `live-check-item ${chk.ok ? "ok" : "warn"}` }, [
          el("div", { class: "live-check-top" }, [
            icon(chk.ok ? "check-circle" : "error-outline"),
            el("strong", { text: chk.label }),
          ]),
          el("p", { class: "muted small", text: chk.detail }),
        ])
      ));
    }
    return status;
  };

  const maybePlayCueAudio = async (cueText, status, audioB64, audioMime) => {
    if (!cueText) return;
    if (audioB64) {
      lastAudioB64 = audioB64;
      lastAudioMime = audioMime || "audio/mpeg";
    }
    const now = Date.now();
    const shouldRepeatReminder = status !== "good" && (now - lastSpokenAt > 8500);
    if (voiceEnabled && (cueText !== lastSpokenCue || shouldRepeatReminder)) {
      lastSpokenCue = cueText;
      lastSpokenAt = now;
      voiceCueBanner.classList.add("is-speaking");
      await speakCoachText(cueText, {
        personaId: getPersonaId(),
        lang,
        audioB64: audioB64 || "",
        audioMime: audioMime || "audio/mpeg",
      });
      voiceCueBanner.classList.remove("is-speaking");
    }
  };

  const analyzeViaWebSocket = async ({ dataUrl, frameHint, fIdx }) => {
    const ws = await ensureLiveWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    const now = Date.now();
    const wantVoice = voiceEnabled && (now - lastSpokenAt > 2500);

    return new Promise((resolve) => {
      let visionData = null;
      let status = "insufficient_evidence";
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        wsPendingHandler = null;
        resolve(ok);
      };
      const timeoutId = setTimeout(() => {
        finish(Boolean(visionData));
      }, 9500);

      wsPendingHandler = async (msg) => {
        if (!msg || msg.frame_index !== fIdx) return;
        if (msg.type === "vision_result") {
          visionData = msg;
          status = applyVisionHudUpdate(msg);
          if (!wantVoice || !msg.voice_cue) {
            finish(true);
          }
        } else if (msg.type === "voice_audio") {
          wsPendingHandler = null;
          clearTimeout(timeoutId);
          const cue = (visionData && visionData.voice_cue) || msg.voice_cue || "";
          await maybePlayCueAudio(cue, status, msg.audio_b64, msg.audio_mime);
          finish(true);
        } else if (msg.type === "voice_audio_done") {
          wsPendingHandler = null;
          clearTimeout(timeoutId);
          const cue = (visionData && visionData.voice_cue) || "";
          await maybePlayCueAudio(cue, status, "", "");
          finish(true);
        }
      };

      try {
        ws.send(JSON.stringify({
          type: "frame",
          exercise_id: guide.id,
          exercise_name: guide.rawName,
          lang,
          persona: getPersonaId(),
          frame_index: fIdx,
          simulation: simulationMode,
          frame_hint: frameHint,
          voice_enabled: wantVoice,
          image_b64: dataUrl,
        }));
      } catch {
        closeLiveWs();
        finish(false);
      }
    });
  };

  const analyzeSingleFrame = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const { blob, dataUrl, frameHint } = await captureFramePayload();
      if (!blob) {
        statusBadge.className = "live-hud-status insufficient";
        statusBadge.textContent = translate(lang, "exercises.waitingForCameraVideo");
        scoreBadge.textContent = translate(lang, "exercises.scoreNoVideo2");
        return;
      }
      const fIdx = frameIndex++;

      // Scheme C primary: Real-time bidirectional WebSocket stream (/api/live-coach/ws)
      if (dataUrl) {
        const wsOk = await analyzeViaWebSocket({ dataUrl, frameHint, fIdx });
        if (wsOk) return;
      }

      // Automatic fallback to HTTP POST /api/form-check if WebSocket is unavailable
      const fd = new FormData();
      fd.append("exercise_id", guide.id);
      fd.append("exercise_name", guide.rawName);
      fd.append("lang", lang);
      fd.append("persona", getPersonaId());
      fd.append("frame_index", String(fIdx));
      fd.append("simulation", simulationMode ? "1" : "0");
      fd.append("frame_hint", frameHint);
      fd.append("image", blob, "frame.jpg");

      const resp = await fetch("/api/form-check", {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      if (!resp.ok) return;
      const res = await resp.json();
      const status = applyVisionHudUpdate(res);
      await maybePlayCueAudio(res.voice_cue, status, res.audio_b64, res.audio_mime);
    } catch { /* ignore transient network error */ } finally {
      inFlight = false;
    }
  };

  // Sequential loop: waits for frame analysis + voice playback to finish before scheduling next check
  // One analysed frame every ~4 s keeps feedback useful while bounding the
  // Gemini vision cost (see the live_frames_per_day limit on the server).
  const LIVE_FRAME_INTERVAL_MS = 4000;
  const runCoachingLoop = async () => {
    clearLoopTimer();
    if (!isCoaching || !document.body.contains(dialog)) return;
    await analyzeSingleFrame();
    if (isCoaching && document.body.contains(dialog)) {
      loopTimerId = setTimeout(runCoachingLoop, LIVE_FRAME_INTERVAL_MS);
    }
  };

  const setCoachingState = async (active, { speakIntro = false } = {}) => {
    unlockCoachAudio();
    if (!active) {
      isCoaching = false;
      clearLoopTimer();
      stopCoachSpeech();
      voiceCueBanner.classList.remove("is-speaking");
      toggleBtn.replaceChildren(icon("play-arrow"), translate(lang, "exercises.resumeLiveCoach"));
      statusBadge.textContent = translate(lang, "exercises.liveCoachPaused");
      return;
    }
    isCoaching = true;
    toggleBtn.replaceChildren(icon("pause"), translate(lang, "exercises.pauseLiveCoach"));
    if (speakIntro && voiceEnabled) {
      const persona = getPersona(getPersonaId(), lang);
      const intro = translate(lang, "exercises.liveCoachReady", { coach: persona.copy.shortName, name: isZh ? guide.zhName : guide.rawName });
      voiceTextEl.textContent = intro;
      voiceCueBanner.classList.add("is-speaking");
      await speakCoachText(intro, { personaId: getPersonaId(), lang });
      voiceCueBanner.classList.remove("is-speaking");
    }
    if (isCoaching && document.body.contains(dialog)) {
      await runCoachingLoop();
    }
  };

  const toggleBtn = el("button", {
    type: "button",
    class: "btn btn-primary live-toggle-btn",
    onclick: () => setCoachingState(!isCoaching, { speakIntro: !isCoaching }),
  }, [icon("pause"), translate(lang, "exercises.pauseLiveCoach")]);

  const voiceToggleBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: () => {
      unlockCoachAudio();
      voiceEnabled = !voiceEnabled;
      if (!voiceEnabled) {
        stopCoachSpeech();
        voiceCueBanner.classList.remove("is-speaking");
      }
      voiceToggleBtn.replaceChildren(
        icon(voiceEnabled ? "volume-up" : "close"),
        translate(lang, voiceEnabled ? "exercises.voiceOn" : "exercises.voiceMuted"),
      );
    },
  }, [icon("volume-up"), translate(lang, "exercises.voiceOn")]);

  const flipCamBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: async () => {
      unlockCoachAudio();
      facingMode = facingMode === "user" ? "environment" : "user";
      await startCamera();
    },
  }, [icon("flip-camera-ios"), translate(lang, "exercises.flipCamera")]);

  const demoModeBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: async () => {
      unlockCoachAudio();
      simulationMode = !simulationMode;
      demoModeBtn.replaceChildren(
        icon("auto-awesome"),
        translate(lang, simulationMode ? "exercises.exitDemo" : "exercises.demoMode"),
      );
      if (simulationMode) {
        videoEl.hidden = true;
        simStageWrap.hidden = false;
        observedSceneBar.textContent = translate(lang, "exercises.demoModeActiveSimulatedFrames");
        await analyzeSingleFrame();
      } else {
        await startCamera();
        await analyzeSingleFrame();
      }
    },
  }, [icon("auto-awesome"), translate(lang, "exercises.demoMode")]);

  const snapNowBtn = el("button", {
    type: "button",
    class: "btn btn-outline btn-sm",
    onclick: () => {
      unlockCoachAudio();
      lastSpokenCue = "";
      analyzeSingleFrame();
    },
  }, [icon("photo-camera"), translate(lang, "exercises.checkNow")]);

  const dialog = el("div", {
    class: "modal-card live-coach-modal",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "live-coach-title",
  }, [
    el("header", { class: "modal-head" }, [
      el("div", {}, [
        el("p", { class: "eyebrow accent", text: translate(lang, "exercises.liveAiVisionVoiceForm") }),
        el("h3", { id: "live-coach-title", text: guide.displayName }),
      ]),
      el("div", { class: "live-head-actions" }, [
        personaSwitchPill({
          compact: true,
          onSwitched: () => {
            unlockCoachAudio();
            lastSpokenCue = "";
            if (isCoaching) analyzeSingleFrame();
          },
        }),
        el("button", {
          type: "button",
          class: "icon-btn",
          "aria-label": translate(lang, "exercises.close"),
          onclick: () => { stopAll(); closeModal(); },
        }, [icon("close")]),
      ]),
    ]),
    el("div", { class: "live-coach-body" }, [
      // Camera viewport + alignment overlay
      el("div", { class: "live-video-stage" }, [
        videoEl,
        simStageWrap,
        // Alignment framing HUD
        el("div", { class: "live-hud-overlay" }, [
          el("div", { class: "live-hud-top" }, [
            statusBadge,
            el("div", { class: "live-hud-metrics" }, [scoreBadge, repBadge]),
          ]),
          el("div", { class: "live-hud-reticle", "aria-hidden": "true" }),
          el("div", { class: "live-hud-bottom" }, [
            el("span", { class: "live-tempo-hint", text: `⏱ ${guide.tempo}` }),
          ]),
        ]),
      ]),

      // Transparent AI scene observation bar
      observedSceneBar,

      // Live voice coaching transcript banner
      voiceCueBanner,

      // 3 biomechanical checkpoints
      checksWrap,

      // Control buttons
      el("div", { class: "live-controls-bar" }, [
        toggleBtn,
        snapNowBtn,
        voiceToggleBtn,
        flipCamBtn,
        demoModeBtn,
      ]),

      // Finish set & send to coach
      el("div", { class: "live-coach-foot" }, [
        el("button", {
          type: "button",
          class: "btn btn-outline btn-sm",
          onclick: () => {
            stopAll();
            closeModal();
            openExerciseDetailModal(exOrId, actions);
          },
        }, [icon("info"), translate(lang, "exercises.viewFormGuide")]),
        el("button", {
          type: "button",
          class: "btn btn-primary btn-sm",
          onclick: () => {
            const scoreStr = lastScore ? `（AI 动作评分 ${lastScore} 分）` : "";
            const repStr = repCount > 0 ? `${repCount} 次` : "";
            stopAll();
            closeModal();
            if (actions && actions.openCoach) {
              actions.openCoach({
                send: isZh
                  ? (repCount > 0
                      ? `我刚刚跟着实时语音伴练完成了 1 组「${guide.zhName}」${repStr}${scoreStr}，帮我记录并给点建议！`
                      : `我刚打开了「${guide.zhName}」实时伴练，请告诉我做这个动作最需要注意的机位角度和发力要点，并帮我记录今天这组训练！`)
                  : (repCount > 0
                      ? `I just finished a set of ${guide.rawName} for ${repCount} reps with the Live Form Coach${lastScore ? ` (Form Score: ${lastScore})` : ""}. Please log it!`
                      : `I just practiced ${guide.rawName} with the Live Form Coach. Can you share key form tips and help me log my set?`),
              });
            }
          },
        }, [icon("check"), translate(lang, "exercises.finishSetLog")]),
      ]),
    ]),
  ]);

  openModal(dialog);
  // Automatically stop camera if backdrop is clicked or Escape is pressed
  const obs = new MutationObserver(() => {
    if (!document.body.contains(dialog)) {
      stopAll();
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  // Start camera and immediately kick off live voice coaching once video warms up
  startCamera().then((camOk) => {
    if (!document.body.contains(dialog)) return;
    if (camOk) {
      setTimeout(() => {
        if (document.body.contains(dialog) && !isCoaching) {
          setCoachingState(true, { speakIntro: true });
        }
      }, 450);
    } else {
      isCoaching = false;
      toggleBtn.replaceChildren(icon("play-arrow"), translate(lang, "exercises.startLiveVoiceCoach"));
    }
  });
}
