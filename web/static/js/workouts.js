// Workout history: what was actually done (exercises, sets x reps, loads,
// effort, notes) next to what was planned for that day.
import { el, icon } from "./util.js";
import { t, num, dateShort, weekdayShort } from "./i18n.js";
import { getJson } from "./api.js";
import { actions } from "./state.js";
import { openModal } from "./modal.js";

const STATUS_ICON = { as_planned: "check-circle", partial: "swap-horiz", different: "swap-horiz", unplanned: "add-circle" };

function dayLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return `${dateShort(date)} · ${weekdayShort((date.getDay() + 6) % 7)}`;
}

function timeSpec(sets, sec) {
  return sec >= 60 && sec % 60 === 0
    ? t("workouts.setsMin", { sets, min: sec / 60 })
    : t("workouts.setsTime", { sets, sec });
}

function setSpec(e) {
  const parts = [];
  if (e.reps) parts.push(t("workouts.setsReps", { sets: e.sets, reps: e.reps }));
  else if (e.duration_seconds) parts.push(timeSpec(e.sets, e.duration_seconds));
  else parts.push(t("workouts.sets", { sets: e.sets }));
  if (e.weight_kg) parts.push(t("unit.kg", { n: num(e.weight_kg, e.weight_kg % 1 ? 1 : 0) }));
  return parts.join(" · ");
}

function planSpec(e) {
  if (e.reps) return t("workouts.setsReps", { sets: e.sets, reps: e.reps });
  if (e.duration_seconds) return timeSpec(e.sets, e.duration_seconds);
  return t("workouts.sets", { sets: e.sets });
}

function statusPill(plan) {
  return el("span", { class: `pill wk-status is-${plan.status}` }, [icon(STATUS_ICON[plan.status] || "info"), t(`workouts.status.${plan.status}`)]);
}

function effortPill(effort) {
  return effort ? el("span", { class: `pill wk-effort is-${effort}` }, [t(`workouts.effort.${effort}`)]) : null;
}

/** Full detail: actual sets next to the planned session for that date. */
export function openWorkoutDetail(s) {
  const actual = el("div", { class: "wk-col" }, [
    el("p", { class: "eyebrow", text: t("workouts.actual") }),
    el("ul", { class: "wk-ex-list" }, s.exercises.map((e) => el("li", {}, [el("span", { class: "wk-ex-name", text: e.exercise_name }), el("span", { class: "wk-ex-spec", text: setSpec(e) })]))),
  ]);
  const planned = s.plan.planned_exercises
    ? el("div", { class: "wk-col is-plan" }, [
        el("p", { class: "eyebrow", text: t("workouts.planned", { focus: s.plan.planned_focus }) }),
        el("ul", { class: "wk-ex-list" }, s.plan.planned_exercises.map((e) => el("li", {}, [el("span", { class: "wk-ex-name", text: e.name }), el("span", { class: "wk-ex-spec", text: planSpec(e) })]))),
      ])
    : el("p", { class: "muted small", text: t("workouts.noPlanThatDay") });
  const ref = { close: () => {} };
  const body = el("div", { class: "modal-body wk-detail" }, [
    el("div", { class: "wk-detail-pills" }, [statusPill(s.plan), effortPill(s.perceived_effort)]),
    el("div", { class: "wk-compare" }, [actual, planned]),
    s.notes ? el("p", { class: "wk-notes" }, [icon("rate-review"), el("span", { text: s.notes })]) : null,
    el("p", { class: "muted small", text: t("workouts.totals", { sets: s.total_sets, volume: num(s.volume_kg) }) }),
    el("div", { class: "wk-detail-actions" }, [
      el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: () => { ref.close(); actions.openCoach({ prefill: t("workouts.askFix", { date: dayLabel(s.local_date) }) }); } }, [icon("edit"), t("workouts.fix")]),
      el("button", { type: "button", class: "btn btn-primary btn-sm", onclick: () => { ref.close(); actions.openCoach({ send: t("workouts.askReview", { date: dayLabel(s.local_date) }) }); } }, [icon("smart-toy"), t("workouts.review")]),
    ]),
  ]);
  const opened = openModal({ subtitle: t("workouts.title"), title: dayLabel(s.local_date), body, cls: "wk-modal" });
  ref.close = opened.close;
}

function sessionItem(s) {
  const preview = s.exercises.slice(0, 4);
  return el("li", {
    class: "wk-item",
    role: "button",
    tabindex: "0",
    onclick: () => openWorkoutDetail(s),
    onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWorkoutDetail(s); } },
  }, [
    el("div", { class: "wk-item-head" }, [
      el("strong", { class: "wk-date", text: dayLabel(s.local_date) }),
      statusPill(s.plan),
      effortPill(s.perceived_effort),
    ]),
    s.plan.planned_focus ? el("p", { class: "muted small wk-plan-line", text: t("workouts.plannedLine", { focus: s.plan.planned_focus }) }) : null,
    el("ul", { class: "wk-ex-list compact" }, [
      ...preview.map((e) => el("li", {}, [el("span", { class: "wk-ex-name", text: e.exercise_name }), el("span", { class: "wk-ex-spec", text: setSpec(e) })])),
      s.exercises.length > preview.length ? el("li", { class: "muted small", text: t("workouts.more", { n: s.exercises.length - preview.length }) }) : null,
    ]),
    s.notes ? el("p", { class: "wk-notes compact" }, [icon("rate-review"), el("span", { text: s.notes })]) : null,
  ]);
}

/** Progress page card: recent logged workouts, newest first, with "load earlier". */
export function workoutHistoryCard() {
  const list = el("ol", { class: "wk-list" });
  const status = el("p", { class: "muted small wk-status-line", text: t("workouts.loading") });
  const more = el("button", { type: "button", class: "btn btn-secondary btn-sm wk-more", hidden: true }, [t("workouts.loadEarlier")]);
  let nextBefore = null;

  async function load(before = null) {
    more.disabled = true;
    try {
      const data = await getJson(`/api/workouts?days=30${before ? `&before=${before}` : ""}`);
      for (const s of data.sessions) list.append(sessionItem(s));
      nextBefore = data.next_before;
      status.hidden = list.children.length > 0;
      status.textContent = t("workouts.empty");
      more.hidden = !nextBefore;
    } catch (err) {
      status.hidden = false;
      status.textContent = err.message || t("workouts.loadFailed");
    } finally {
      more.disabled = false;
    }
  }
  more.addEventListener("click", () => load(nextBefore));
  load();
  return el("section", { class: "card wk-card span-2", "aria-labelledby": "wk-heading" }, [
    el("div", { class: "card-header" }, [
      el("div", { class: "card-heading" }, [icon("fitness-center", { cls: "accent" }), el("h2", { id: "wk-heading", text: t("workouts.title") })]),
      el("button", { type: "button", class: "link-btn", onclick: () => actions.openCoach({ prefill: t("workouts.logPrompt") }) }, [icon("add"), t("workouts.log")]),
    ]),
    status,
    list,
    more,
  ]);
}

/** Plan page: open what was actually logged on a given date. */
export async function openWorkoutForDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const next = new Date(y, m - 1, d + 1);
  const before = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  const data = await getJson(`/api/workouts?days=1&before=${before}`);
  if (data.sessions.length) openWorkoutDetail(data.sessions[0]);
}
