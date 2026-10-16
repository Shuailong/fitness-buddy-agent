// Feedback UI: thumbs under coach replies and cards (thumbs-down opens a small
// reasons sheet), the once-a-day inline "Was this helpful?" prompt, and the
// global "Send feedback" dialog. Everything posts to /api/feedback.
import { el, icon, isoDate } from "./util.js";
import { postJson, isRateLimited } from "./api.js";
import { t, getLang, duration } from "./i18n.js";
import { track } from "./telemetry.js";
import { openModal } from "./modal.js";

const REASONS = ["inaccurate", "not_helpful", "too_slow", "unsafe", "wrong_numbers", "other"];
const CATEGORIES = ["bug", "idea", "nutrition", "workouts", "other"];
const CSAT_ICONS = ["sentiment-very-dissatisfied", "sentiment-dissatisfied", "sentiment-neutral", "sentiment-satisfied", "sentiment-very-satisfied"];
const RATINGS_KEY = "fb.ratings";
const PROMPT_KEY = "fb.dailyPrompt";
const MAX_RATINGS = 300;

let uidSeq = 0;
const uid = (p) => `${p}-${++uidSeq}`;

// ------------------------------------------------------------- storage
function loadRatings() {
  try { return JSON.parse(localStorage.getItem(RATINGS_KEY)) || {}; } catch (_) { return {}; }
}

function saveRating(eventId, rating) {
  if (!eventId) return;
  const all = loadRatings();
  delete all[eventId];
  all[eventId] = rating;
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_RATINGS))) delete all[k];
  try { localStorage.setItem(RATINGS_KEY, JSON.stringify(all)); } catch (_) { /* storage disabled */ }
}

// ------------------------------------------------------------- API
/** POST /api/feedback; enforces the server limits (6 tags x 40 chars, 2000-char comment). */
export async function submitFeedback({ kind, rating = null, tags = [], comment = "", eventId = null, page = null }) {
  const body = {
    kind,
    rating,
    tags: [...new Set(tags.filter(Boolean))].slice(0, 6).map((s) => String(s).slice(0, 40)),
    comment: String(comment || "").trim().slice(0, 2000),
    lang: getLang(),
  };
  if (eventId) body.event_id = eventId;
  if (page) body.page = page;
  await postJson("/api/feedback", body);
}

const errorText = (err) => (isRateLimited(err) ? t("fb.rateLimited", { time: duration(err.retryAfter || 30) }) : t("fb.error"));

/** Multi-select chips (same look as the onboarding chips). */
function chipGroup(name, values, labelKey, selected, labelledBy) {
  return el("div", { class: "chip-group fb-chips", role: "group", "aria-labelledby": labelledBy }, values.map((v) => {
    const id = uid(name);
    const input = el("input", { type: "checkbox", id, value: v, class: "sr-only" });
    input.addEventListener("change", () => (input.checked ? selected.add(v) : selected.delete(v)));
    return el("label", { for: id, class: "select-chip" }, [input, el("span", { class: "chip-face" }, [icon("check", { cls: "chk" }), t(`${labelKey}.${v}`)])]);
  }));
}

// ------------------------------------------------------------- thumbs
/** Inline "What went wrong?" sheet shown under a reply after thumbs-down. */
function reasonSheet({ onSend, onCancel }) {
  const selected = new Set();
  const titleId = uid("fb-sheet");
  const comment = el("textarea", { class: "text-input fb-comment", rows: "2", maxlength: "2000", placeholder: t("fb.commentOptional"), "aria-label": t("fb.commentOptional") });
  const error = el("p", { class: "fb-error", role: "alert", hidden: true });
  const sendBtn = el("button", { type: "submit", class: "btn btn-primary btn-sm" }, [t("fb.send")]);
  const cancelBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => onCancel() }, [t("fb.cancel")]);
  const ui = {
    busy(on) { sendBtn.disabled = on; cancelBtn.disabled = on; sendBtn.textContent = t(on ? "fb.sending" : "fb.send"); },
    error(msg) { error.textContent = msg; error.hidden = !msg; },
  };
  const form = el("form", { class: "fb-sheet", "aria-labelledby": titleId }, [
    el("p", { class: "fb-sheet-title", id: titleId, text: t("fb.sheetTitle") }),
    chipGroup("fb-reason", REASONS, "fb.reason", selected, titleId),
    comment,
    error,
    el("div", { class: "fb-sheet-actions" }, [cancelBtn, sendBtn]),
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    ui.error("");
    onSend([...selected], comment.value, ui);
  });
  form.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
  });
  return form;
}

/**
 * Thumbs up/down pair under a coach reply or card. One rating per message;
 * the user can change it. Thumbs-up submits at once, thumbs-down asks why.
 * opts: { eventId, tags (context tags, e.g. ["meal_card"]), kind, label, page, onRated(rating) }
 */
export function feedbackThumbs({ eventId = null, tags = [], kind = "message", label = null, page = "coach", onRated = null, cls = "" } = {}) {
  let rating = eventId ? loadRatings()[eventId] || null : null;
  let sheet = null;
  const status = el("span", { class: "fb-status", role: "status" });
  const makeBtn = (dir) => el("button", {
    type: "button", class: `fb-btn fb-${dir}`, "aria-label": t(dir === "up" ? "fb.up" : "fb.down"), title: t(dir === "up" ? "fb.up" : "fb.down"),
    onclick: () => (dir === "up" ? rateUp() : openSheet()),
  });
  const up = makeBtn("up");
  const down = makeBtn("down");
  const root = el("div", { class: `fb ${cls}`.trim() }, [
    el("div", { class: "fb-bar", role: "group", "aria-label": label || t("fb.rateReply") }, [up, down, status]),
  ]);

  function paint() {
    for (const [btn, dir] of [[up, "up"], [down, "down"]]) {
      const on = rating === dir;
      btn.replaceChildren(icon(dir === "up" ? "thumb-up" : "thumb-down", { fill: on }));
      btn.setAttribute("aria-pressed", String(on));
      btn.classList.toggle("on", on);
    }
    root.classList.toggle("rated", Boolean(rating));
  }

  function say(text, tone = "ok") {
    status.textContent = text;
    status.className = `fb-status ${tone}`;
  }

  const send = (r, extraTags = [], comment = "") => submitFeedback({ kind, rating: r, tags: [...tags, ...extraTags], comment, eventId, page });

  async function rateUp() {
    if (rating === "up") return;
    closeSheet();
    const prev = rating;
    rating = "up";
    paint();
    say(t("fb.thanks"));
    try {
      await send("up");
      saveRating(eventId, "up");
      if (onRated) onRated("up");
    } catch (err) {
      rating = prev;
      paint();
      say(errorText(err), "err");
    }
  }

  function openSheet() {
    if (sheet) { sheet.querySelector("input")?.focus(); return; }
    say("");
    track("feedback_open", { kind });
    sheet = reasonSheet({
      onCancel: () => { closeSheet(); down.focus(); },
      onSend: async (reasons, comment, ui) => {
        ui.busy(true);
        try {
          await send("down", reasons, comment);
          rating = "down";
          saveRating(eventId, "down");
          paint();
          closeSheet();
          say(t("fb.thanks"));
          down.focus();
          if (onRated) onRated("down");
        } catch (err) {
          ui.busy(false);
          ui.error(errorText(err));
        }
      },
    });
    root.classList.add("open");
    root.append(sheet);
    sheet.querySelector("input")?.focus({ preventScroll: true });
    sheet.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    root.classList.remove("open");
  }

  paint();
  return root;
}

// ------------------------------------------------------------- daily prompt
let completedTurns = 0;
let promptShown = false;

/**
 * Call after every completed coach turn. On the 3rd one (at most once per day)
 * it returns a dismissible "Was this helpful today?" row; otherwise null.
 */
export function dailyPromptAfterTurn(eventId = null) {
  completedTurns += 1;
  if (promptShown || completedTurns < 3) return null;
  const today = isoDate(new Date());
  try {
    if (localStorage.getItem(PROMPT_KEY) === today) return null;
    localStorage.setItem(PROMPT_KEY, today);
  } catch (_) { return null; }
  promptShown = true;
  const row = el("div", { class: "row system fb-daily-row" });
  const dismiss = () => row.remove();
  row.append(el("div", { class: "fb-daily" }, [
    el("span", { class: "fb-daily-text", text: t("fb.daily") }),
    feedbackThumbs({ eventId, kind: "general", tags: ["daily_prompt"], label: t("fb.daily"), page: "coach", cls: "fb-inline", onRated: () => setTimeout(dismiss, 2500) }),
    el("button", { type: "button", class: "fb-dismiss", "aria-label": t("fb.dismiss"), title: t("fb.dismiss"), onclick: dismiss }, [icon("close")]),
  ]));
  return row;
}

// ------------------------------------------------------------- global dialog
/** "Send feedback" modal (bottom sheet on phones). page: where it was opened. */
export function openFeedbackDialog({ page = null } = {}) {
  track("feedback_open", { kind: "general" });
  const categories = new Set();
  let csat = 0;
  const qId = uid("fbd-q");
  const catId = uid("fbd-cat");
  const commentId = uid("fbd-comment");
  const hintId = uid("fbd-hint");

  const faces = el("div", { class: "csat", role: "radiogroup", "aria-labelledby": qId }, CSAT_ICONS.map((name, i) => {
    const id = uid("csat");
    const input = el("input", { type: "radio", name: qId, id, value: String(i + 1), class: "sr-only" });
    input.addEventListener("change", () => { csat = i + 1; error.hidden = true; });
    return el("label", { for: id, class: "csat-opt" }, [input, el("span", { class: "csat-face" }, [icon(name), el("span", { class: "csat-label", text: t(`fb.csat.${i + 1}`) })])]);
  }));
  const comment = el("textarea", { id: commentId, class: "text-input", rows: "4", maxlength: "2000", placeholder: t("fb.commentPlaceholder"), "aria-describedby": hintId });
  comment.addEventListener("input", () => { error.hidden = true; });
  const error = el("p", { class: "fb-error", role: "alert", hidden: true });
  const sendBtn = el("button", { type: "submit", class: "btn btn-primary" }, [t("fb.send")]);

  const form = el("form", { class: "modal-body fb-form", novalidate: true }, [
    el("p", { class: "modal-q", id: qId, text: t("fb.csatQ") }),
    faces,
    el("p", { class: "modal-q", id: catId, text: t("fb.categoryQ") }),
    chipGroup("fbd-cat", CATEGORIES, "fb.cat", categories, catId),
    el("label", { class: "modal-q", for: commentId, text: t("fb.commentLabel") }),
    comment,
    el("p", { class: "field-hint", id: hintId, text: t("fb.commentHint") }),
    el("p", { class: "fb-note" }, [icon("lock"), t("fb.privacyNote")]),
    error,
    el("div", { class: "modal-actions" }, [
      el("button", { type: "button", class: "btn btn-secondary", onclick: () => modal.close() }, [t("fb.cancel")]),
      sendBtn,
    ]),
  ]);

  const modal = openModal({ title: t("fb.dialogTitle"), body: form, cls: "fb-modal" });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = comment.value.trim();
    if (!csat && !text) {
      error.textContent = t("fb.needInput");
      error.hidden = false;
      comment.focus();
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = t("fb.sending");
    try {
      await submitFeedback({ kind: "general", rating: null, tags: [csat ? `csat_${csat}` : null, ...categories], comment: text, page });
      const closeBtn = el("button", { type: "button", class: "btn btn-primary", onclick: () => modal.close() }, [t("fb.close")]);
      form.replaceWith(el("div", { class: "modal-body fb-success", role: "status" }, [
        el("span", { class: "fb-success-icon", "aria-hidden": "true" }, [icon("check-circle", { fill: true })]),
        el("p", { class: "fb-success-title", text: t("fb.successTitle") }),
        el("p", { class: "fb-success-text", text: t("fb.successText") }),
        el("div", { class: "modal-actions single" }, [closeBtn]),
      ]));
      closeBtn.focus();
    } catch (err) {
      sendBtn.disabled = false;
      sendBtn.textContent = t("fb.send");
      error.textContent = errorText(err);
      error.hidden = false;
    }
  });
  return modal;
}
