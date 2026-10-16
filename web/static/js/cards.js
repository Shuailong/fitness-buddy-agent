// Structured cards rendered inside the Coach chat: "meal logged" result cards
// and confirmation (approval) cards rendered by `kind`.
import { el, icon, fmt, humanize, capitalize } from "./util.js";
import { WEEKDAYS, WEEKDAY_SHORT, parseExercise, shortFocus, weekdayIndex } from "./logic.js";

const kcal = (n) => `${fmt(n)} kcal`;
const grams = (n) => `${fmt(n)} g`;

// ------------------------------------------------------------ meal logged
/**
 * ctx: { prefill(text), send(text) }
 */
export function mealLoggedCard(card, ctx) {
  const mealType = card.meal_type || "meal";
  const totals = card.totals || {};
  const day = card.day || {};
  const consumed = day.consumed || {};
  const items = Array.isArray(card.items) ? card.items : [];
  const lowConfidence = items.some((i) => i.confidence === "low");

  const progress = [];
  if (day.target_calories_kcal) progress.push(`${fmt(consumed.calories_kcal)} / ${fmt(day.target_calories_kcal)} kcal`);
  else if (consumed.calories_kcal !== undefined) progress.push(`${fmt(consumed.calories_kcal)} kcal today`);
  if (day.target_protein_g) progress.push(`${fmt(consumed.protein_g)} / ${fmt(day.target_protein_g)} g protein`);

  const undoBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("undo"), "Undo"]);
  const fixBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("edit"), "Fix it"]);
  fixBtn.addEventListener("click", () => ctx.prefill(`Correct my ${mealType}: `));
  undoBtn.addEventListener("click", () => ctx.send(`Please delete the ${mealType} I just logged.`));

  return el("article", { class: "chat-card meal-card", "aria-label": `${capitalize(mealType)} logged` }, [
    el("div", { class: "card-head" }, [
      el("span", { class: "badge badge-ok" }, [icon("check"), "Logged"]),
      el("h3", { class: "card-title" }, [capitalize(mealType)]),
    ]),
    el("ul", { class: "item-rows" }, items.map((i) => el("li", {}, [
      el("span", { class: "item-name" }, [i.name, i.portion_grams ? el("span", { class: "muted", text: ` ~${fmt(i.portion_grams)} g` }) : null]),
      el("span", { class: "item-kcal", text: kcal(i.calories_kcal) }),
    ]))),
    el("div", { class: "totals-row" }, [
      icon("local-fire-department"),
      el("span", { class: "totals" }, [
        el("strong", { text: `≈ ${kcal(totals.calories_kcal)}` }),
        ` · P ${grams(totals.protein_g)} · C ${grams(totals.carbs_g)} · F ${grams(totals.fat_g)}`,
      ]),
      el("span", { class: "estimate", text: lowConfidence ? "Rough estimate" : "Estimate" }),
    ]),
    progress.length ? el("p", { class: "day-progress" }, [el("span", { class: "muted", text: "Today: " }), progress.join(" · ")]) : null,
    el("div", { class: "card-actions" }, [fixBtn, undoBtn]),
  ]);
}

// ------------------------------------------------------------ confirmations
function decisionFooter(card, { yes, no, onDecide }) {
  const yesBtn = el("button", { class: "btn btn-primary", type: "button" }, [icon("check"), yes]);
  const noBtn = el("button", { class: "btn btn-secondary", type: "button", text: no });
  const status = el("p", { class: "decided", role: "status", hidden: true });
  const actionsRow = el("div", { class: "card-actions" }, [yesBtn, noBtn]);
  const decide = (confirmed) => onDecide(confirmed, { lock });
  function lock(confirmed) {
    yesBtn.disabled = true;
    noBtn.disabled = true;
    card.dataset.state = confirmed ? "approved" : "declined";
    status.hidden = false;
    status.replaceChildren(icon(confirmed ? "check-circle" : "undo"), confirmed ? "Approved" : (no === "Request changes" ? "Changes requested" : "Not applied"));
    status.className = `decided ${confirmed ? "yes" : "no"}`;
    actionsRow.hidden = true;
  }
  yesBtn.addEventListener("click", () => decide(true));
  noBtn.addEventListener("click", () => decide(false));
  return [actionsRow, status];
}

function renderDetails(value, depth = 0) {
  if (value === null || value === undefined) return document.createTextNode("–");
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null)) return document.createTextNode(value.join(", "));
    return el("ul", { class: "kv" }, value.map((v, i) => el("li", {}, [el("span", { class: "k", text: `#${i + 1}` }), renderDetails(v, depth + 1)])));
  }
  if (typeof value === "object") {
    if (depth > 4) return document.createTextNode(JSON.stringify(value));
    return el("ul", { class: "kv" }, Object.entries(value).map(([k, v]) =>
      el("li", {}, [el("span", { class: "k", text: `${humanize(k)}:` }), " ", renderDetails(v, depth + 1)])));
  }
  return document.createTextNode(String(value));
}

function cardShell(card, children) {
  return el("article", { class: "chat-card confirm-card", "data-call-id": card.call_id, "aria-label": card.title || "Approval needed" }, children);
}

function approvalHead(card, title) {
  return el("div", { class: "card-head" }, [
    el("span", { class: "badge badge-warn" }, [icon("warning"), "Approval needed"]),
    el("h3", { class: "card-title", text: title || card.title }),
    card.summary ? el("p", { class: "card-summary", text: card.summary }) : null,
  ]);
}

function planCard(card, onDecide) {
  const d = card.details || {};
  const sessions = (Array.isArray(d.sessions) ? d.sessions : []).slice().sort((a, b) => weekdayIndex(a.day) - weekdayIndex(b.day));
  const byDay = new Map(sessions.map((s) => [String(s.day || "").toLowerCase(), s]));
  const strip = el("ol", { class: "week-strip compact", "aria-label": "Weekly rhythm" }, WEEKDAYS.map((day, i) => {
    const s = byDay.get(day);
    return el("li", { class: `day-pill${s ? " train" : " rest"}` }, [
      el("span", { class: "dow", text: WEEKDAY_SHORT[i] }),
      el("span", { class: "focus", text: s ? shortFocus(s.focus) : "Rest" }),
    ]);
  }));
  const rows = sessions.map((s, idx) => {
    const exercises = (Array.isArray(s.exercises) ? s.exercises : []).map(parseExercise);
    const dayName = WEEKDAY_SHORT[weekdayIndex(s.day)] || capitalize(s.day);
    return el("details", { class: "session-row", open: idx === 0 }, [
      el("summary", {}, [
        el("span", { class: "dot", "aria-hidden": "true" }),
        el("span", { class: "session-text" }, [
          el("span", { class: "session-title", text: `${dayName}: ${s.focus || "Session"}` }),
          el("span", { class: "session-meta", text: `${s.minutes ? `${s.minutes} min · ` : ""}${exercises.length} exercises` }),
        ]),
        icon("expand-more", { cls: "chev" }),
      ]),
      el("ul", { class: "exercise-list" }, exercises.map((ex) => el("li", {}, [
        el("span", { class: "ex-name" }, [ex.name, ex.note ? el("span", { class: "tag", text: ex.note }) : null]),
        ex.spec ? el("span", { class: "ex-spec", text: ex.spec }) : null,
      ]))),
    ]);
  });
  const node = cardShell(card, [
    approvalHead(card, d.title ? `Save new plan: ${d.title}` : card.title),
    sessions.length ? el("div", { class: "card-band" }, [el("p", { class: "eyebrow", text: "Weekly rhythm" }), strip]) : null,
    rows.length ? el("div", { class: "session-rows" }, rows) : null,
    d.progression ? el("p", { class: "note-row" }, [icon("info"), el("span", {}, [el("strong", { text: "Progression: " }), String(d.progression)])]) : null,
    typeof d.replaces === "string" && d.replaces ? el("p", { class: "note-row muted" }, [icon("swap-horiz"), `Replaces: ${d.replaces}`]) : null,
  ]);
  node.append(...decisionFooter(node, { yes: "Approve plan", no: "Request changes", onDecide }));
  return node;
}

function calorieCard(card, onDecide) {
  const d = card.details || {};
  const reasons = Array.isArray(d.clamp_reasons) ? d.clamp_reasons : [];
  const node = cardShell(card, [
    approvalHead(card),
    el("div", { class: "kcal-change" }, [
      el("span", { class: "old", text: fmt(d.current_kcal) }),
      icon("arrow-forward"),
      el("span", { class: "new", text: fmt(d.new_kcal) }),
      el("span", { class: "unit", text: "kcal/day" }),
    ]),
    el("div", { class: "macro-chips" }, [
      d.protein_g !== undefined ? el("span", { class: "macro-chip protein" }, [el("b", { text: grams(d.protein_g) }), " protein"]) : null,
      d.carbs_g !== undefined ? el("span", { class: "macro-chip carbs" }, [el("b", { text: grams(d.carbs_g) }), " carbs"]) : null,
      d.fat_g !== undefined ? el("span", { class: "macro-chip fat" }, [el("b", { text: grams(d.fat_g) }), " fat"]) : null,
    ]),
    reasons.length ? el("ul", { class: "reasons" }, reasons.map((r) => el("li", {}, [icon("shield"), String(r)]))) : null,
  ]);
  node.append(...decisionFooter(node, { yes: "Approve", no: "Keep current", onDecide }));
  return node;
}

function genericCard(card, onDecide) {
  const hasDetails = card.details && Object.keys(card.details).length > 0;
  const node = cardShell(card, [
    approvalHead(card),
    hasDetails ? el("details", { class: "generic-details" }, [el("summary", {}, ["Details", icon("expand-more", { cls: "chev" })]), renderDetails(card.details)]) : null,
  ]);
  node.append(...decisionFooter(node, { yes: "Confirm", no: "Cancel", onDecide }));
  return node;
}

/**
 * onDecide(confirmed, { lock }) is called on click; it must call lock(confirmed)
 * once the decision is accepted and may return false to keep the card active.
 */
export function confirmationCard(card, onDecide) {
  if (card.kind === "replace_training_plan") return planCard(card, onDecide);
  if (card.kind === "update_calorie_target") return calorieCard(card, onDecide);
  return genericCard(card, onDecide);
}
