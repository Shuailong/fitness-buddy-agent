// Structured cards rendered inside the Coach chat: "meal logged" result cards
// and confirmation (approval) cards rendered by `kind`. All labels are
// localized at render time; data from the coach (food names, plan focus,
// exercise names, reasons) is shown as-is.
import { el, icon, humanize } from "./util.js";
import { t, getLang, num, kcal, grams, dateShort, weekdayShort } from "./i18n.js";
import { WEEKDAYS, parseExercise, shortFocus, weekdayIndex, confirmationTitle } from "./logic.js";
import { openPhotoLightbox } from "./modal.js";

const mealName = (type) => t(`meal.${type || "meal"}`);
const mealLower = (type) => t(`mealLower.${["breakfast", "lunch", "dinner", "snack"].includes(type) ? type : "meal"}`);

// ------------------------------------------------------------ meal logged
/** ctx: { prefill(text), send(text) } */
export function mealLoggedCard(card, ctx) {
  const mealType = card.meal_type || "meal";
  const totals = card.totals || {};
  const day = card.day || {};
  const consumed = day.consumed || {};
  const items = Array.isArray(card.items) ? card.items : [];
  const lowConfidence = items.some((i) => i.confidence === "low");

  const progress = [];
  if (day.target_calories_kcal) progress.push(t("card.dayKcal", { a: num(consumed.calories_kcal), b: num(day.target_calories_kcal) }));
  else if (consumed.calories_kcal !== undefined) progress.push(t("card.dayKcalOnly", { a: num(consumed.calories_kcal) }));
  if (day.target_protein_g) progress.push(t("card.dayProtein", { a: num(consumed.protein_g), b: num(day.target_protein_g) }));

  const undoBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("undo"), t("card.undo")]);
  const fixBtn = el("button", { class: "btn btn-secondary btn-sm", type: "button" }, [icon("edit"), t("card.fixIt")]);
  fixBtn.addEventListener("click", () => ctx.prefill(t("send.fixMeal", { meal: mealLower(mealType) })));
  undoBtn.addEventListener("click", () => ctx.send(t("send.undoMeal", { meal: mealLower(mealType) })));

  let photoBanner = null;
  if (card.photo_url) {
    const caption = items.map((i) => i.name).join(getLang() === "zh" ? "、" : ", ") || mealName(mealType);
    const img = el("img", { class: "meal-card-photo", src: card.photo_url, alt: caption });
    const wrap = el(
      "button",
      {
        type: "button",
        class: "meal-card-photo-btn",
        "aria-label": t("mealDetail.photoHint"),
        onclick: () => openPhotoLightbox(card.photo_url, caption),
      },
      [
        img,
        el("span", { class: "meal-detail-zoom-pill" }, [
          icon("open-in-new"),
          el("span", { text: t("mealDetail.photoHint") }),
        ]),
      ],
    );
    img.addEventListener("error", () => wrap.remove());
    photoBanner = wrap;
  }

  return el("article", { class: "chat-card meal-card", "aria-label": t("card.mealLogged", { meal: mealName(mealType) }) }, [
    el("div", { class: "card-head" }, [
      el("span", { class: "badge badge-ok" }, [icon("check"), t("card.logged")]),
      el("h3", { class: "card-title", text: mealName(mealType) }),
    ]),
    photoBanner,
    el("ul", { class: "item-rows" }, items.map((i) => el("li", {}, [
      el("span", { class: "item-name" }, [i.name, i.portion_grams ? el("span", { class: "muted", text: t("card.portion", { n: num(i.portion_grams) }) }) : null]),
      el("span", { class: "item-kcal", text: kcal(i.calories_kcal) }),
    ]))),
    el("div", { class: "totals-row" }, [
      icon("local-fire-department"),
      el("span", { class: "totals" }, [
        el("strong", { text: `≈ ${kcal(totals.calories_kcal)}` }),
        t("card.macros", { p: grams(totals.protein_g), c: grams(totals.carbs_g), f: grams(totals.fat_g) }),
      ]),
      el("span", { class: "estimate", text: lowConfidence ? t("card.roughEstimate") : t("card.estimate") }),
    ]),
    progress.length ? el("p", { class: "day-progress" }, [el("span", { class: "muted", text: t("card.todayLabel") }), progress.join(" · ")]) : null,
    el("div", { class: "card-actions" }, [fixBtn, undoBtn]),
  ]);
}

// ------------------------------------------------------------ confirmations
function decisionFooter(card, { yes, no, noDone, onDecide }) {
  const yesBtn = el("button", { class: "btn btn-primary", type: "button" }, [icon("check"), yes]);
  const noBtn = el("button", { class: "btn btn-secondary", type: "button", text: no });
  const status = el("p", { class: "decided", role: "status", hidden: true });
  const actionsRow = el("div", { class: "card-actions" }, [yesBtn, noBtn]);
  function lock(confirmed) {
    yesBtn.disabled = true;
    noBtn.disabled = true;
    card.dataset.state = confirmed ? "approved" : "declined";
    status.hidden = false;
    status.replaceChildren(icon(confirmed ? "check-circle" : "undo"), confirmed ? t("card.decided.approved") : noDone);
    status.className = `decided ${confirmed ? "yes" : "no"}`;
    actionsRow.hidden = true;
  }
  function unlock() {
    yesBtn.disabled = false;
    noBtn.disabled = false;
    delete card.dataset.state;
    status.hidden = true;
    status.replaceChildren();
    actionsRow.hidden = false;
  }
  yesBtn.addEventListener("click", () => onDecide(true, { lock, unlock }));
  noBtn.addEventListener("click", () => onDecide(false, { lock, unlock }));
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

/** The free-text reason the coach gave (after "Reason:" in the server summary). */
function reasonOf(summary) {
  const m = String(summary || "").match(/Reason:\s*([\s\S]+)$/);
  return m ? m[1].trim() : "";
}

function cardShell(card, title, children) {
  return el("article", { class: "chat-card confirm-card", "data-call-id": card.call_id, "aria-label": title }, children);
}

function approvalHead(title, summary) {
  return el("div", { class: "card-head" }, [
    el("span", { class: "badge badge-warn" }, [icon("warning"), t("card.approval")]),
    el("h3", { class: "card-title", text: title }),
    summary ? el("p", { class: "card-summary", text: summary }) : null,
  ]);
}

function reasonRow(summary) {
  const reason = reasonOf(summary);
  return reason ? el("p", { class: "note-row" }, [icon("info"), el("span", {}, [el("strong", { text: t("card.reason") }), reason])]) : null;
}

function planCard(card, onDecide) {
  const d = card.details || {};
  const title = confirmationTitle(card.kind, { replaces: d.replaces, serverTitle: card.title }, getLang());
  const sessions = (Array.isArray(d.sessions) ? d.sessions : []).slice().sort((a, b) => weekdayIndex(a.day) - weekdayIndex(b.day));
  const byDay = new Map(sessions.map((s) => [String(s.day || "").toLowerCase(), s]));
  const strip = el("ol", { class: "week-strip compact", "aria-label": t("card.weeklyRhythm") }, WEEKDAYS.map((day, i) => {
    const s = byDay.get(day);
    return el("li", { class: `day-pill${s ? " train" : " rest"}` }, [
      el("span", { class: "dow", text: weekdayShort(i) }),
      el("span", { class: "focus", text: s ? shortFocus(s.focus) : t("card.rest") }),
    ]);
  }));
  const rows = sessions.map((s, idx) => {
    const exercises = (Array.isArray(s.exercises) ? s.exercises : []).map(parseExercise);
    const wd = weekdayIndex(s.day);
    const dayName = wd >= 0 ? weekdayShort(wd) : String(s.day || "");
    const meta = s.minutes ? t("card.sessionMeta", { min: num(s.minutes), n: exercises.length }) : t("card.sessionMetaNoMin", { n: exercises.length });
    return el("details", { class: "session-row", open: idx === 0 }, [
      el("summary", {}, [
        el("span", { class: "dot", "aria-hidden": "true" }),
        el("span", { class: "session-text" }, [
          el("span", { class: "session-title", text: `${dayName}${getLang() === "zh" ? "：" : ": "}${s.focus || t("card.session")}` }),
          el("span", { class: "session-meta", text: meta }),
        ]),
        icon("expand-more", { cls: "chev" }),
      ]),
      el("ul", { class: "exercise-list" }, exercises.map((ex) => el("li", {}, [
        el("span", { class: "ex-name" }, [ex.name, ex.note ? el("span", { class: "tag", text: ex.note }) : null]),
        ex.spec ? el("span", { class: "ex-spec", text: ex.spec }) : null,
      ]))),
    ]);
  });
  const node = cardShell(card, title, [
    approvalHead(title, d.title || null),
    sessions.length ? el("div", { class: "card-band" }, [el("p", { class: "eyebrow", text: t("card.weeklyRhythm") }), strip]) : null,
    rows.length ? el("div", { class: "session-rows" }, rows) : null,
    d.progression ? el("p", { class: "note-row" }, [icon("info"), el("span", {}, [el("strong", { text: t("card.progression") }), String(d.progression)])]) : null,
    typeof d.replaces === "string" && d.replaces ? el("p", { class: "note-row muted" }, [icon("swap-horiz"), t("card.replaces", { x: d.replaces })]) : null,
  ]);
  node.append(...decisionFooter(node, { yes: t("card.approvePlan"), no: t("card.requestChanges"), noDone: t("card.decided.changes"), onDecide }));
  return node;
}

function calorieCard(card, onDecide) {
  const d = card.details || {};
  const title = confirmationTitle(card.kind, { serverTitle: card.title }, getLang());
  const reasons = Array.isArray(d.clamp_reasons) ? d.clamp_reasons : [];
  const clampText = (r) => { const key = `clamp.${r}`; const v = t(key); return v === key ? String(r) : v; };
  const node = cardShell(card, title, [
    approvalHead(title),
    el("div", { class: "kcal-change" }, [
      el("span", { class: "old", text: num(d.current_kcal) }),
      icon("arrow-forward"),
      el("span", { class: "new", text: num(d.new_kcal) }),
      el("span", { class: "unit", text: t("card.kcalDay") }),
    ]),
    el("div", { class: "macro-chips" }, [
      d.protein_g !== undefined ? el("span", { class: "macro-chip" }, [t("card.macroProtein", { g: grams(d.protein_g) })]) : null,
      d.carbs_g !== undefined ? el("span", { class: "macro-chip" }, [t("card.macroCarbs", { g: grams(d.carbs_g) })]) : null,
      d.fat_g !== undefined ? el("span", { class: "macro-chip" }, [t("card.macroFat", { g: grams(d.fat_g) })]) : null,
    ]),
    reasons.length ? el("ul", { class: "reasons" }, reasons.map((r) => el("li", {}, [icon("shield"), clampText(r)]))) : null,
    reasonRow(card.summary),
  ]);
  node.append(...decisionFooter(node, { yes: t("card.approve"), no: t("card.keepCurrent"), noDone: t("card.decided.kept"), onDecide }));
  return node;
}

function deleteSummary(kind, d) {
  const date = d.local_date ? dateShort(d.local_date) : "";
  if (kind === "delete_meal") {
    const what = Array.isArray(d.items) && d.items.length ? `${t(`meal.${d.meal_type || "meal"}`)}: ${d.items.map((i) => i.name).join(", ")}` : t(`meal.${d.meal_type || "meal"}`);
    return t("card.deleteMealSummary", { meal: what, date, kcal: kcal(d.totals && d.totals.calories_kcal) });
  }
  if (kind === "delete_workout") {
    const list = (d.exercises || []).map((e) => `${e.exercise_name} ${e.sets}×${e.reps || (e.duration_seconds ? t("unit.sec", { n: e.duration_seconds }) : "")}`).join(", ");
    return t("card.deleteWorkoutSummary", { date, list: list || "–" });
  }
  const parts = [];
  if (d.weight_kg) parts.push(t("unit.kg", { n: num(d.weight_kg, 1) }));
  if (d.body_fat_percent) parts.push(`${num(d.body_fat_percent, 1)}%`);
  if (d.waist_cm) parts.push(`${num(d.waist_cm, 1)} cm`);
  return t("card.deleteMeasurementSummary", { date, value: parts.join(" · ") || "–" });
}

function deleteCard(card, onDecide) {
  const d = card.details || {};
  const title = confirmationTitle(card.kind, { serverTitle: card.title }, getLang());
  const node = cardShell(card, title, [
    approvalHead(title, `${deleteSummary(card.kind, d)} ${t("card.cannotUndo")}`),
    reasonRow(card.summary),
  ]);
  node.append(...decisionFooter(node, { yes: t("card.confirm"), no: t("card.cancel"), noDone: t("card.decided.cancelled"), onDecide }));
  return node;
}

function genericCard(card, onDecide) {
  const title = confirmationTitle(card.kind, { serverTitle: card.title }, getLang());
  const hasDetails = card.details && Object.keys(card.details).length > 0;
  const node = cardShell(card, title, [
    approvalHead(title, card.summary),
    hasDetails ? el("details", { class: "generic-details" }, [el("summary", {}, [t("card.details"), icon("expand-more", { cls: "chev" })]), renderDetails(card.details)]) : null,
  ]);
  node.append(...decisionFooter(node, { yes: t("card.confirm"), no: t("card.cancel"), noDone: t("card.decided.cancelled"), onDecide }));
  return node;
}

/**
 * onDecide(confirmed, { lock }) is called on click; it must call lock(confirmed)
 * once the decision is accepted.
 */
export function confirmationCard(card, onDecide) {
  if (card.kind === "replace_training_plan" || card.kind === "update_plan_day") return planCard(card, onDecide);
  if (card.kind === "update_calorie_target") return calorieCard(card, onDecide);
  if (/^delete_(meal|workout|measurement)$/.test(card.kind || "")) return deleteCard(card, onDecide);
  return genericCard(card, onDecide);
}
