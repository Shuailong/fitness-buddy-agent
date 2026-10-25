// Live "thinking" line for agent turns (ChatGPT-style): one shimmering line
// with the current step and elapsed time, tap to see all steps; a duration
// hint for slow specialists; a reconnect status when the connection drops;
// a collapsed "N steps · 48 s" (or "Stopped") summary once the turn ends.
import { el, icon } from "./util.js";
import { t } from "./i18n.js";

// Activity labels come from web/events.py (ACTIVITY_LABELS / ACTIVITY_LABELS_ZH).
const HINTS = [
  [/workout planner|训练规划师/i, "turn.hint.plan"],
  [/weekly reviewer|周报教练|每周复盘/i, "turn.hint.review"],
  [/nutrition coach|营养教练/i, "turn.hint.meal"],
];

/** "0:23" style elapsed clock. */
export function clockText(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "48 s" / "48 秒", "1 min 55 s" / "1 分 55 秒". */
export function durationText(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? t("turn.sec", { n: s }) : t("turn.minSec", { m: Math.floor(s / 60), s: s % 60 });
}

export const cleanLabel = (label) => String(label || "").replace(/(\.\.\.|…)\s*$/, "").trim();

export class TurnProgress {
  constructor() {
    this.start = Date.now();
    this.steps = [];
    this.finished = false;
    this.hintKey = null;
    this.timeEl = el("span", { class: "pc-time", "aria-hidden": "true" });
    this.hintEl = el("p", { class: "pc-hint", hidden: true });
    this.statusEl = el("p", { class: "pc-status", hidden: true, role: "status" });
    this.titleEl = el("span", { class: "pc-title pc-shimmer", text: t("coach.thinking") });
    this.chevEl = el("span", { class: "pc-chev", hidden: true, "aria-hidden": "true" }, [icon("expand-more")]);
    this.listEl = el("ol", { class: "pc-steps", hidden: true, "aria-label": t("turn.steps"), role: "status", "aria-live": "polite" });
    this.headEl = el("button", {
      type: "button",
      class: "pc-head",
      "aria-expanded": "false",
      onclick: () => this.toggle(),
    }, [
      el("span", { class: "pc-orb", "aria-hidden": "true" }),
      this.titleEl,
      this.timeEl,
      this.chevEl,
    ]);
    this.node = el("div", { class: "progress-card live" }, [
      this.headEl,
      this.statusEl,
      this.hintEl,
      this.listEl,
    ]);
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  tick() {
    this.timeEl.textContent = clockText(Date.now() - this.start);
  }

  toggle() {
    if (!this.steps.length || this.finished) return;
    const open = this.listEl.hidden;
    this.listEl.hidden = !open;
    this.headEl.setAttribute("aria-expanded", String(open));
    this.node.classList.toggle("is-open", open);
  }

  /** Shows (or clears, with null) a status line such as "reconnecting…". */
  setStatus(text, iconName = "info") {
    if (!text) {
      this.statusEl.hidden = true;
      return;
    }
    this.statusEl.replaceChildren(icon(iconName), el("span", { text }));
    this.statusEl.hidden = false;
  }

  /** Adds a step for a new activity label (repeated labels are ignored). */
  addStep(label) {
    const text = cleanLabel(label);
    if (!text || this.finished || this.steps.some((s) => s.text === text)) return false;
    for (const s of this.steps) this.markDone(s);
    const li = el("li", { class: "pc-step active" }, [el("span", { class: "pc-step-icon", "aria-hidden": "true" }, [el("span", { class: "pc-spinner" })]), el("span", { text })]);
    this.steps.push({ text, li });
    this.listEl.append(li);
    // The line always shows what the coach is doing right now.
    this.titleEl.textContent = text;
    this.chevEl.hidden = false;
    if (!this.hintKey) {
      const hit = HINTS.find(([re]) => re.test(text));
      if (hit) this.showHint(hit[1]);
    }
    return true;
  }

  showHint(key) {
    this.hintKey = key;
    this.hintEl.replaceChildren(icon("schedule"), t(key));
    this.hintEl.hidden = false;
  }

  markDone(step) {
    if (!step.li.classList.contains("active")) return;
    step.li.classList.remove("active");
    step.li.querySelector(".pc-step-icon").replaceChildren(icon("check"));
  }

  /** Stops the timer and removes the card without a summary (e.g. the request was rate-limited). */
  discard() {
    this.finished = true;
    clearInterval(this.timer);
    this.node.remove();
  }

  /** Stops the timer and collapses into a summary line. Returns false if the card was removed. */
  finish({ error = false, stopped = false } = {}) {
    if (this.finished) return !!this.node.isConnected;
    this.finished = true;
    clearInterval(this.timer);
    const elapsed = Date.now() - this.start;
    for (const s of this.steps) this.markDone(s);
    this.listEl.hidden = false;
    if (!this.steps.length && elapsed < 2500 && !error && !stopped) {
      this.node.remove();
      return false;
    }
    const label = stopped
      ? t("turn.stopped", { t: durationText(elapsed) })
      : this.steps.length
        ? t(this.steps.length === 1 ? "turn.summaryOne" : "turn.summary", { n: this.steps.length, t: durationText(elapsed) })
        : t("turn.summaryNoSteps", { t: durationText(elapsed) });
    const summaryIcon = icon(stopped ? "pause" : error ? "warning" : "check-circle");
    this.node.className = `progress-card done${error ? " error" : ""}${stopped ? " stopped" : ""}`;
    if (this.steps.length) {
      this.listEl.removeAttribute("role");
      this.listEl.removeAttribute("aria-live");
      this.node.replaceChildren(el("details", { class: "pc-summary" }, [
        el("summary", {}, [summaryIcon, el("span", { text: label }), icon("expand-more", { cls: "chev" })]),
        this.listEl,
      ]));
    } else {
      this.node.replaceChildren(el("p", { class: "pc-summary-line" }, [summaryIcon, label]));
    }
    return true;
  }
}
