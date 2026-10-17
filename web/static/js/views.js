// Dashboard views: Today, Progress and Plan (all driven by GET /api/dashboard).
// Every label comes from i18n.js; plan/exercise names from the coach stay as-is.
import { el, icon, parseDate, isoDate, addDays, clamp, richText, isNum } from "./util.js";
import { t, getLang, num, signedNum, kcal, grams, mins, dateLong, dateShort, weekdayShort, weekdayLong, clock } from "./i18n.js";
import { calorieRing, miniRing, weightChart, calorieBars } from "./charts.js";
import {
  WEEKDAYS, MEAL_ICONS, coachTip, greetingFor, firstName, nextMealType,
  exerciseSpec, sortedSessions, weekdayIndex, weightDelta,
} from "./logic.js";
import { state, actions } from "./state.js";
import { track } from "./telemetry.js";
import { openModal, openPhotoLightbox } from "./modal.js";

const goalLabel = (g) => t(`goal.${g}`);
const mealName = (type) => t(`meal.${type || "meal"}`);
const mealLower = (type) => t(`mealLower.${["breakfast", "lunch", "dinner", "snack"].includes(type) ? type : "meal"}`);
const dayLong = (day) => weekdayLong(weekdayIndex(day));

function card(cls, children, attrs = {}) {
  return el("section", { class: `card ${cls}`.trim(), ...attrs }, children);
}

function cardHeader(iconName, title, right = null) {
  return el("div", { class: "card-header" }, [
    el("div", { class: "card-heading" }, [iconName ? icon(iconName, { cls: "accent", fill: iconName === "bolt" }) : null, el("h2", { text: title })]),
    right,
  ]);
}

function emptyState(iconName, title, text, button = null) {
  return el("div", { class: "empty" }, [
    el("span", { class: "empty-icon" }, [icon(iconName)]),
    el("h3", { text: title }),
    text ? el("p", { class: "muted", text }) : null,
    button,
  ]);
}

function primaryBtn(label, iconName, onclick, extra = "") {
  return el("button", { type: "button", class: `btn btn-primary ${extra}`.trim(), onclick }, [iconName ? icon(iconName, { fill: iconName === "play-arrow" }) : null, label]);
}

function secondaryBtn(label, iconName, onclick, extra = "") {
  return el("button", { type: "button", class: `btn btn-secondary ${extra}`.trim(), onclick }, [iconName ? icon(iconName) : null, label]);
}

export function loadingView() {
  return el("div", { class: "loading", role: "status" }, [el("span", { class: "spinner", "aria-hidden": "true" }), t("loading")]);
}

export function errorView(message, retry) {
  return card("", [emptyState("warning", t("error.loadTitle"), message, secondaryBtn(t("error.tryAgain"), null, retry))]);
}

export function setupProfileView(onClick) {
  return card("", [el("div", { class: "empty" }, [
    el("h3", { text: t("profile.setupTitle") }),
    el("p", { class: "muted", text: t("profile.setupText") }),
    primaryBtn(t("profile.setupBtn"), null, onClick),
  ])]);
}

const startSession = (session, isToday = true) => actions.openCoach({
  send: isToday ? t("send.startToday", { focus: session.focus }) : t("send.startDay", { day: dayLong(session.day_of_week), focus: session.focus }),
});
const createPlan = () => actions.openCoach({ send: t("send.createPlan") });

// ================================================================== TODAY
function macroBar(name, cls, value, target) {
  const pct = target ? clamp((value / target) * 100, 0, 100) : 0;
  return el("div", { class: `macro ${cls}` }, [
    el("div", { class: "macro-row" }, [
      el("span", { class: "macro-name" }, [el("i", { class: "swatch", "aria-hidden": "true" }), name]),
      el("span", { class: "macro-val" }, [el("b", { text: num(value) }), target ? ` / ${t("unit.gShort", { n: num(target) })}` : t("unit.gShort", { n: "" })]),
    ]),
    el("div", { class: `bar-track${target && value > target ? " over" : ""}`, role: "progressbar", "aria-label": name, "aria-valuemin": 0, "aria-valuemax": target || 0, "aria-valuenow": Math.round(value || 0) }, [
      el("span", { style: { width: `${pct}%` } }),
    ]),
  ]);
}

function heroCard(d) {
  const today = d.nutrition.today;
  const tg = d.targets || {};
  const consumed = today.consumed || {};
  const target = today.target_calories_kcal;
  const remaining = today.remaining_calories_kcal;
  let pace = null;
  if (tg.daily_calories_kcal && tg.tdee_kcal) {
    const diff = tg.daily_calories_kcal - tg.tdee_kcal;
    pace = t(diff < -100 ? "today.pace.deficit" : diff > 100 ? "today.pace.surplus" : "today.pace.maintenance");
  }
  const left = !isNum(remaining) ? null
    : remaining >= 0 ? el("span", { class: "pill pill-primary", text: t("today.left", { n: num(remaining) }) })
      : el("span", { class: "pill pill-warn", text: t("today.over", { n: num(-remaining) }) });
  return card("hero", [
    el("div", { class: "glow", "aria-hidden": "true" }),
    cardHeader("bolt", t("today.balance"), pace ? el("span", { class: "tag-muted", text: pace }) : null),
    el("div", { class: "hero-grid" }, [
      el("div", { class: "ring-col" }, [
        el("div", { class: "ring-wrap" }, [
          calorieRing(consumed.calories_kcal || 0, target, { label: target ? t("today.ringAria", { a: num(consumed.calories_kcal), b: num(target) }) : kcal(consumed.calories_kcal) }),
          el("div", { class: "ring-center", "aria-hidden": "true" }, [
            el("span", { class: "ring-value-text", text: num(consumed.calories_kcal) }),
            el("span", { class: "ring-sub", text: target ? t("today.ringOf", { n: num(target) }) : t("today.ringNoTarget") }),
          ]),
        ]),
        left,
      ]),
      el("div", { class: "macros" }, [
        macroBar(t("macro.protein"), "protein", consumed.protein_g || 0, tg.protein_g || today.target_protein_g),
        macroBar(t("macro.carbs"), "carbs", consumed.carbs_g || 0, tg.carbs_g),
        macroBar(t("macro.fat"), "fat", consumed.fat_g || 0, tg.fat_g),
      ]),
    ]),
    !target ? el("p", { class: "muted small", text: t("today.noTargets") }) : null,
  ], { "aria-label": t("today.balance") });
}

function quickActions() {
  const btn = (iconName, label, onclick) => el("button", { type: "button", class: "quick", onclick }, [icon(iconName, { cls: "accent" }), el("span", { text: label })]);
  return el("div", { class: "quick-actions" }, [
    btn("photo-camera", t("today.quick.snap"), () => { track("quick_action", { action: "snap_meal" }); actions.openCoach({ photo: "camera" }); }),
    btn("fitness-center", t("today.quick.log"), () => { track("quick_action", { action: "log_workout" }); actions.openCoach({ prefill: t("send.logWorkout") }); }),
    btn("forum", t("today.quick.ask"), () => { track("quick_action", { action: "ask_coach" }); actions.openCoach({ focus: true }); }),
  ]);
}

function tipCard(d) {
  const tip = coachTip(d, new Date(), getLang());
  return card("tip", [
    el("span", { class: "tip-icon", "aria-hidden": "true" }, [icon("smart-toy", { fill: true })]),
    el("div", { class: "tip-body" }, [
      el("p", { class: "eyebrow accent", text: t("today.tip") }),
      el("p", { class: "tip-text" }, richText(tip.parts)),
      el("button", { type: "button", class: "link-btn", onclick: () => actions.openCoach({ send: tip.question }) }, [t("today.askWhy"), icon("arrow-forward")]),
    ]),
  ], { "aria-label": t("today.tip") });
}

function workoutCard(d) {
  const plan = d.plan;
  if (!plan) {
    return card("workout", [
      cardHeader("fitness-center", t("today.workout")),
      emptyState("event-note", t("today.noPlanTitle"), t("today.noPlanText"), primaryBtn(t("today.createPlan"), "add", createPlan)),
    ]);
  }
  const s = d.today_session;
  const sessions = sortedSessions(plan);
  if (!s) {
    const todayIdx = weekdayIndex(d.weekday);
    const next = sessions.find((x) => weekdayIndex(x.day_of_week) > todayIdx) || sessions[0];
    return card("workout rest", [
      cardHeader("hotel", t("today.restTitle")),
      el("p", { class: "muted", text: t("today.restText") }),
      next ? el("p", { class: "next-up" }, [el("span", { class: "muted", text: t("today.nextSession") }), el("strong", { text: `${dayLong(next.day_of_week)} · ${next.focus}` })]) : null,
      secondaryBtn(t("today.viewPlan"), "event-note", () => actions.navigate("plan"), "btn-block"),
    ]);
  }
  const position = sessions.findIndex((x) => x.day_of_week === s.day_of_week) + 1;
  const preview = s.exercises.slice(0, 4);
  const more = s.exercises.length - preview.length;
  return card("workout", [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("p", { class: "eyebrow accent", text: t("today.sessionPos", { n: position, total: sessions.length }) }),
        el("h2", { class: "workout-title", text: s.focus }),
      ]),
      d.today_session_done ? el("span", { class: "pill pill-primary" }, [icon("check"), t("today.done")]) : el("span", { class: "round-icon", "aria-hidden": "true" }, [icon("calendar-today")]),
    ]),
    el("div", { class: "meta-row" }, [
      el("span", {}, [icon("schedule", { cls: "accent" }), mins(s.estimated_minutes)]),
      el("span", { class: "sep", "aria-hidden": "true", text: "•" }),
      el("span", {}, [icon("fitness-center", { cls: "accent" }), t("today.exercises", { n: s.exercises.length })]),
    ]),
    el("ol", { class: "ex-preview" }, preview.map((ex, i) => el("li", {}, [
      el("span", { class: "num", text: String(i + 1) }),
      el("span", { class: "ex-name", text: ex.name }),
      el("span", { class: "ex-spec", text: exerciseSpec(ex, getLang()) }),
    ]))),
    more > 0 ? el("button", { type: "button", class: "link-btn", onclick: () => actions.navigate("plan") }, [t("today.more", { n: more }), icon("chevron-right")]) : null,
    d.today_session_done
      ? secondaryBtn(t("today.sessionLogged"), "check-circle", () => actions.navigate("plan"), "btn-block")
      : primaryBtn(t("today.start"), "play-arrow", () => startSession(s), "btn-block"),
  ], { "aria-label": t("today.workout") });
}

function openMealDetailModal(m, d) {
  const totals = m.totals || {};
  const itemDetails = Array.isArray(m.item_details) && m.item_details.length
    ? m.item_details
    : (m.items || []).map((name) => (typeof name === "object" && name !== null ? name : { name: String(name) }));
  const titleText = (m.items || [])
    .map((x) => (typeof x === "object" && x !== null ? x.name : x))
    .join(getLang() === "zh" ? "、" : ", ") || mealName(m.meal_type);
  const timeStr = clock(m.logged_at, d.timezone);
  const modalTitle = timeStr ? `${mealName(m.meal_type)} · ${timeStr}` : mealName(m.meal_type);

  const pKcal = (totals.protein_g || 0) * 4;
  const cKcal = (totals.carbs_g || 0) * 4;
  const fKcal = (totals.fat_g || 0) * 9;
  const macroCalSum = Math.max(pKcal + cKcal + fKcal, 1);
  const pPct = Math.round((pKcal / macroCalSum) * 100);
  const cPct = Math.round((cKcal / macroCalSum) * 100);
  const fPct = Math.max(0, 100 - pPct - cPct);

  let photoSection = null;
  if (m.photo_url) {
    const img = el("img", {
      class: "meal-detail-photo",
      src: m.photo_url,
      alt: titleText,
    });
    const wrap = el(
      "button",
      {
        type: "button",
        class: "meal-detail-photo-wrap",
        "aria-label": t("mealDetail.photoHint"),
        onclick: () => openPhotoLightbox(m.photo_url, titleText),
      },
      [
        img,
        el("span", { class: "meal-detail-zoom-pill" }, [
          icon("open-in-new"),
          el("span", { text: t("mealDetail.photoHint") }),
        ]),
      ],
    );
    img.addEventListener("error", () => {
      wrap.replaceWith(
        el("div", { class: "meal-photo-missing" }, [
          icon("photo-camera"),
          el("span", { text: t("mealDetail.photoUnavailable") }),
        ]),
      );
    });
    photoSection = wrap;
  }

  const macroCard = (cls, label, gramsVal, pctVal) =>
    el("div", { class: `meal-macro-card ${cls}` }, [
      el("div", { class: "meal-macro-top" }, [
        el("i", { class: "swatch", "aria-hidden": "true" }),
        el("span", { class: "meal-macro-label", text: label }),
      ]),
      el("strong", { class: "meal-macro-val", text: grams(gramsVal || 0) }),
      el("span", { class: "muted small", text: t("mealDetail.macroShare", { pct: pctVal }) }),
    ]);

  const modalRef = { close: () => {} };
  const fixBtn = el(
    "button",
    {
      type: "button",
      class: "btn btn-secondary btn-sm",
      onclick: () => {
        modalRef.close();
        actions.openCoach({ prefill: t("send.fixMeal", { meal: mealLower(m.meal_type) }) });
      },
    },
    [icon("edit"), t("card.fixIt")],
  );
  const undoBtn = el(
    "button",
    {
      type: "button",
      class: "btn btn-secondary btn-sm",
      onclick: () => {
        modalRef.close();
        actions.openCoach({ send: t("send.undoMeal", { meal: mealLower(m.meal_type) }) });
      },
    },
    [icon("undo"), t("card.undo")],
  );

  const body = el("div", { class: "modal-body meal-detail-body" }, [
    photoSection,
    el("div", { class: "meal-detail-summary" }, [
      el("div", { class: "meal-detail-badges" }, [
        el("span", { class: "pill pill-outline" }, [
          icon(m.source === "photo" ? "photo-camera" : "edit-square"),
          el("span", { text: t(m.source === "photo" ? "mealDetail.sourcePhoto" : "mealDetail.sourceText") }),
        ]),
        el("span", { class: "tag-muted", text: t("mealDetail.conf.medium") }),
      ]),
      el("div", { class: "meal-detail-kcal" }, [
        el("b", { text: num(totals.calories_kcal || 0) }),
        el("span", { text: t("unit.kcalWord") }),
      ]),
    ]),
    el("div", { class: "meal-macro-stack", "aria-hidden": "true" }, [
      el("span", { class: "seg protein", style: { width: `${pPct}%` } }),
      el("span", { class: "seg carbs", style: { width: `${cPct}%` } }),
      el("span", { class: "seg fat", style: { width: `${fPct}%` } }),
    ]),
    el("div", { class: "meal-detail-macros" }, [
      macroCard("protein", t("macro.protein"), totals.protein_g, pPct),
      macroCard("carbs", t("macro.carbs"), totals.carbs_g, cPct),
      macroCard("fat", t("macro.fat"), totals.fat_g, fPct),
    ]),
    itemDetails.length
      ? el("div", { class: "meal-detail-items-sec" }, [
          el("p", { class: "eyebrow", text: t("mealDetail.itemsTitle", { n: itemDetails.length }) }),
          el(
            "ul",
            { class: "meal-detail-items" },
            itemDetails.map((item) => {
              const confKey = item.confidence ? `mealDetail.conf.${item.confidence}` : null;
              const hasItemMacros =
                item.protein_g !== undefined || item.carbs_g !== undefined || item.fat_g !== undefined;
              return el("li", { class: "meal-detail-item" }, [
                el("div", { class: "meal-detail-item-main" }, [
                  el("div", { class: "meal-detail-item-head" }, [
                    el("strong", { text: item.name }),
                    item.portion_grams
                      ? el("span", { class: "tag-muted", text: `${num(item.portion_grams)}g` })
                      : null,
                    confKey && item.confidence === "low"
                      ? el("span", { class: "tag-muted", text: t(confKey) })
                      : null,
                  ]),
                  hasItemMacros
                    ? el("p", {
                        class: "muted small",
                        text: `${t("macro.protein")} ${num(item.protein_g || 0, 1)}g · ${t("macro.carbs")} ${num(item.carbs_g || 0, 1)}g · ${t("macro.fat")} ${num(item.fat_g || 0, 1)}g`,
                      })
                    : null,
                ]),
                item.calories_kcal !== undefined
                  ? el("span", { class: "meal-detail-item-kcal", text: kcal(item.calories_kcal) })
                  : null,
              ]);
            }),
          ),
        ])
      : null,
    el("div", { class: "meal-detail-actions" }, [fixBtn, undoBtn]),
  ]);

  const opened = openModal({ title: modalTitle, body, cls: "meal-detail-modal" });
  modalRef.close = opened.close;
}

function mealsCard(d) {
  const meals = d.nutrition.meals_today || [];
  const next = nextMealType(meals, new Date().getHours());
  const total = meals.reduce((sum, m) => sum + ((m.totals && m.totals.calories_kcal) || 0), 0);
  return el("section", { class: "meals", "aria-label": t("today.meals") }, [
    el("div", { class: "section-header" }, [
      el("h2", { text: t("today.meals") }),
      el("span", { class: "muted small", text: meals.length ? t("today.mealsLogged", { n: meals.length, kcal: kcal(total) }) : t("today.mealsNone") }),
    ]),
    el(
      "ul",
      { class: "meal-list" },
      meals.map((m) => {
        const titleText =
          (m.items || [])
            .map((x) => (typeof x === "object" && x !== null ? x.name : x))
            .join(getLang() === "zh" ? "、" : ", ") || mealName(m.meal_type);
        const tot = m.totals || {};
        const macroMeta =
          tot.protein_g !== undefined
            ? ` · P ${num(tot.protein_g)}g · C ${num(tot.carbs_g || 0)}g · F ${num(tot.fat_g || 0)}g`
            : "";
        const iconSlot = el("span", { class: `meal-icon ${m.meal_type}`, "aria-hidden": "true" }, [
          icon(MEAL_ICONS[m.meal_type] || "restaurant"),
        ]);
        if (m.photo_url) {
          const thumb = el("img", { class: "meal-row-thumb", src: m.photo_url, alt: "" });
          thumb.addEventListener("error", () => thumb.remove());
          iconSlot.append(thumb);
        }
        if (m.source === "photo" || m.photo_url) {
          iconSlot.append(el("span", { class: "meal-photo-badge" }, [icon("photo-camera")]));
        }
        const open = () => openMealDetailModal(m, d);
        return el(
          "li",
          {
            class: "meal-row is-interactive",
            role: "button",
            tabindex: "0",
            "aria-label": t("mealDetail.viewAria", { meal: titleText }),
            onclick: open,
            onkeydown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                open();
              }
            },
          },
          [
            iconSlot,
            el("div", { class: "meal-text" }, [
              el("p", { class: "meal-name", text: titleText }),
              el("p", { class: "meal-meta", text: `${mealName(m.meal_type)} · ${clock(m.logged_at, d.timezone)}${macroMeta}` }),
            ]),
            el("div", { class: "meal-kcal-wrap" }, [
              el("div", { class: "meal-kcal" }, [
                el("b", { text: num(tot.calories_kcal) }),
                el("span", { text: t("unit.kcalWord") }),
              ]),
              icon("chevron-right", { cls: "meal-chev" }),
            ]),
          ],
        );
      }),
    ),
    el("button", { type: "button", class: "add-row", onclick: () => actions.openCoach({ photo: "camera" }) }, [icon("add-circle"), t("today.addMeal", { meal: t(`mealLower.${next}`) })]),
  ]);
}

function weightMiniCard(d) {
  const pts = d.weight.points || [];
  const delta = weightDelta(pts);
  return card("weight-mini desktop-only", [
    cardHeader("trending-down", t("today.weightTrend"), el("span", { class: "muted small", text: t("today.lastDays", { n: d.range_days }) })),
    pts.length ? el("div", { class: "big-number" }, [
      el("span", { class: "num", text: num(d.weight.latest_weight_kg, 1) }), el("span", { class: "unit", text: t("unit.kgWord") }),
      delta ? el("span", { class: "delta", text: t("unit.kg", { n: signedNum(delta.delta) }) }) : null,
    ]) : null,
    pts.length > 1 ? weightChart(pts, { compact: true, height: 120 }) : el("p", { class: "muted", text: t("today.weightHint") }),
    secondaryBtn(t("today.seeProgress"), "monitoring", () => actions.navigate("progress"), "btn-block"),
  ]);
}

export function renderToday(root, d) {
  const now = new Date();
  const name = firstName(state.me);
  const greeting = greetingFor(now.getHours(), getLang());
  const streak = d.nutrition.logging_streak_days || 0;
  root.replaceChildren(
    el("header", { class: "greeting" }, [
      el("div", { class: "greeting-row" }, [
        el("h1", { text: name ? t("greet.withName", { greeting, name }) : greeting }),
        el("span", { class: "date", text: dateLong(d.today) }),
      ]),
      el("div", { class: "chips" }, [
        el("span", { class: "chip" }, [icon("target", { cls: "accent", fill: true }), t("today.goalChip"), el("strong", { text: goalLabel(d.goal) })]),
        streak > 0 ? el("span", { class: "chip" }, [icon("local-fire-department", { cls: "streak", fill: true }), t("today.streak", { n: streak })]) : null,
      ]),
    ]),
    el("div", { class: "dash-grid today-grid" }, [
      el("div", { class: "area-tip" }, [tipCard(d)]),
      el("div", { class: "area-hero" }, [heroCard(d)]),
      el("div", { class: "area-quick" }, [quickActions()]),
      el("div", { class: "area-weight" }, [weightMiniCard(d)]),
      el("div", { class: "area-workout" }, [workoutCard(d)]),
      el("div", { class: "area-meals" }, [mealsCard(d)]),
    ]),
  );
}

// =============================================================== PROGRESS
function rangeControl(current, onChange) {
  return el("div", { class: "segmented", role: "group", "aria-label": t("progress.range") }, [14, 30, 90].map((v) =>
    el("button", { type: "button", class: v === current ? "active" : "", "aria-pressed": String(v === current), onclick: () => onChange(v) }, [t(`progress.r${v}`)])));
}

function weightCard(d) {
  const w = d.weight;
  const pts = w.points || [];
  const delta = weightDelta(pts);
  if (pts.length < 2) {
    return card("weight", [
      cardHeader("monitor-weight", t("progress.weightTrend")),
      emptyState("monitor-weight", pts.length ? t("progress.oneWeighIn") : t("progress.noWeighIns"), t("progress.weighText"),
        secondaryBtn(t("progress.logWeight"), "add", () => actions.openCoach({ prefill: t("send.logWeight") }))),
    ]);
  }
  const trendIcon = delta.delta < -0.05 ? "trending-down" : delta.delta > 0.05 ? "trending-up" : "trending-flat";
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => pts[Math.round(f * (pts.length - 1))]);
  const wide = window.matchMedia("(min-width: 1024px)").matches;
  return card("weight", [
    el("div", { class: "weight-head" }, [
      el("div", {}, [
        el("p", { class: "eyebrow", text: t("progress.currentWeight") }),
        el("p", { class: "big-number" }, [el("span", { class: "num", text: num(w.latest_weight_kg, 1) }), el("span", { class: "unit", text: t("unit.kgWord") })]),
      ]),
      el("div", { class: "weight-delta" }, [
        el("span", { class: "pill pill-primary" }, [icon(trendIcon), t("progress.delta", { d: signedNum(delta.delta), n: delta.days })]),
        isNum(delta.perWeek) ? el("span", { class: "muted small", text: t("progress.perWeek", { d: signedNum(delta.perWeek) }) }) : null,
      ]),
    ]),
    weightChart(pts, wide ? { width: 800, height: 240 } : {}),
    el("div", { class: "x-labels", "aria-hidden": "true" }, [...new Set(xLabels)].map((p, i, arr) => el("span", { text: i === arr.length - 1 && p.local_date === d.today ? t("progress.today") : dateShort(p.local_date) }))),
    el("div", { class: "legend" }, [
      el("span", {}, [el("i", { class: "lg-dot" }), t("progress.legendDaily")]),
      el("span", {}, [el("i", { class: "lg-line" }), t("progress.legendAvg")]),
    ]),
  ], { "aria-label": t("progress.weightTrend") });
}

function caloriesCard(d) {
  const n = d.nutrition;
  const target = (d.targets && d.targets.daily_calories_kcal) || null;
  const logged = n.days.filter((x) => x.meals_logged > 0);
  const avg = logged.length ? logged.reduce((s, x) => s + x.calories_kcal, 0) / logged.length : null;
  return card("calories", [
    cardHeader(null, t("progress.calories"), target ? el("span", { class: "pill pill-outline", text: t("progress.target", { n: num(target) }) }) : null),
    el("p", { class: "muted small sub", text: t("today.lastDays", { n: n.days.length }) }),
    logged.length ? calorieBars(n.days, target) : emptyState("restaurant", t("progress.noMeals"), t("progress.noMealsText")),
    logged.length ? el("div", { class: "chart-foot" }, [
      el("span", { class: "muted", text: t("progress.daysAgo", { n: n.days.length }) }),
      el("span", { class: "strong", text: t("progress.avg", { kcal: kcal(avg), n: logged.length, total: n.days.length }) }),
      el("span", { class: "muted", text: t("progress.today") }),
    ]) : null,
  ], { "aria-label": t("progress.calories") });
}

function proteinCard(d) {
  const n = d.nutrition;
  const goal = (d.targets && d.targets.protein_g) || null;
  const rate = n.days.length ? Math.round((n.protein_hit_days / n.days.length) * 100) : 0;
  return card("protein", [
    cardHeader(null, t("progress.protein"), icon("restaurant", { cls: "accent" })),
    el("p", { class: "muted small sub", text: goal ? t("progress.proteinGoal", { g: grams(goal) }) : t("progress.proteinNoGoal") }),
    el("ol", { class: "hit-grid", "aria-label": t("progress.proteinAria") }, n.days.map((day) => {
      const status = !day.meals_logged ? "none" : day.protein_target_hit ? "hit" : "miss";
      const label = `${dateShort(day.local_date)}: ${status === "none" ? t("progress.none") : t(`progress.${status}`, { g: grams(day.protein_g) })}`;
      return el("li", { class: `hit is-${status}`, title: label }, [
        status === "hit" ? icon("check") : status === "miss" ? icon("close") : el("span", { "aria-hidden": "true", text: "–" }),
        el("span", { class: "sr-only", text: label }),
      ]);
    })),
    el("div", { class: "card-foot" }, [
      el("span", { text: t("progress.hitFoot", { n: n.protein_hit_days, total: n.days.length }) }),
      el("span", { class: "accent strong", text: t("progress.rate", { n: rate }) }),
    ]),
  ], { "aria-label": t("progress.protein") });
}

function workoutsCard(d) {
  const wk = d.week;
  const planned = wk.planned_sessions || 0;
  const done = wk.completed_sessions || 0;
  const hist = wk.history || [];
  const maxBar = Math.max(planned, ...hist.map((h) => h.sessions), 1);
  const left = planned - done;
  return card("workouts", [
    cardHeader(null, t("progress.workouts"), icon("fitness-center", { cls: "accent" })),
    el("div", { class: "workouts-body" }, [
      el("div", { class: "ring-wrap small" }, [
        miniRing(done, planned || Math.max(done, 1), { label: planned ? t("progress.ringAria", { done, planned }) : t("progress.ringAriaNoPlan", { done }) }),
        el("div", { class: "ring-center", "aria-hidden": "true" }, [
          el("span", { class: "ring-value-text sm", text: planned ? `${done}/${planned}` : String(done) }),
          el("span", { class: "ring-sub", text: t("progress.sessions") }),
        ]),
      ]),
      el("div", { class: "history" }, [
        el("p", { class: "muted small", text: t("progress.last4") }),
        el("ol", { class: "history-bars" }, hist.map((h, i) => {
          const isNow = i === hist.length - 1;
          return el("li", { class: isNow ? "now" : "" }, [
            el("span", { class: "hbar-track" }, [el("span", { class: "hbar", style: { height: `${Math.max(6, (h.sessions / maxBar) * 100)}%` } })]),
            el("span", { class: "hlabel", text: isNow ? t("progress.now") : planned ? `${h.sessions}/${planned}` : String(h.sessions) }),
            el("span", { class: "sr-only", text: t("progress.weekAria", { date: dateShort(h.week_end), n: h.sessions }) }),
          ]);
        })),
      ]),
    ]),
    el("div", { class: "card-foot" }, [
      el("span", { text: planned ? t("progress.targetSessions", { n: planned }) : t("progress.noPlan") }),
      planned ? el("span", { class: "accent strong", text: left > 0 ? t("progress.toGo", { n: left }) : t("progress.targetHit") }) : el("button", { type: "button", class: "link-btn", onclick: createPlan }, [t("today.createPlan")]),
    ]),
  ], { "aria-label": t("progress.workouts") });
}

function reviewCard(d) {
  const r = d.latest_review;
  if (!r) {
    return card("review tip", [
      el("span", { class: "tip-icon", "aria-hidden": "true" }, [icon("smart-toy", { fill: true })]),
      el("div", { class: "tip-body" }, [
        el("p", { class: "eyebrow accent", text: t("progress.review") }),
        el("p", { class: "tip-text", text: t("progress.reviewEmpty") }),
      ]),
    ]);
  }
  return card("review tip", [
    el("span", { class: "tip-icon", "aria-hidden": "true" }, [icon("smart-toy", { fill: true })]),
    el("div", { class: "tip-body" }, [
      el("p", { class: "eyebrow accent", text: t("progress.reviewDate", { date: dateShort(r.week_end) }) }),
      el("p", { class: "tip-text clamp-3", text: r.summary }),
      el("button", { type: "button", class: "link-btn", onclick: () => actions.openCoach({ send: t("send.review") }) }, [t("progress.readReview"), icon("arrow-forward")]),
    ]),
  ], { "aria-label": t("progress.review") });
}

export function renderProgress(root, d, onRange) {
  root.replaceChildren(
    el("header", { class: "page-head" }, [el("h1", { text: t("progress.title") })]),
    rangeControl(d.range_days || state.range, onRange),
    el("div", { class: "dash-grid progress-grid" }, [
      el("div", { class: "span-2" }, [weightCard(d)]),
      caloriesCard(d),
      proteinCard(d),
      workoutsCard(d),
      reviewCard(d),
    ]),
  );
}

// =================================================================== PLAN
function weekStrip(d, sessionsByDay, onPick) {
  const today = parseDate(d.today);
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const done = new Set((d.week && d.week.workout_dates) || []);
  return el("ol", { class: "week-strip big", "aria-label": t("plan.week") }, WEEKDAYS.map((day, i) => {
    const date = addDays(monday, i);
    const iso = isoDate(date);
    const isToday = iso === d.today;
    const isDone = done.has(iso);
    const session = sessionsByDay.get(day);
    const cls = ["day-pill", session ? "train" : "rest", isToday ? "today" : "", isDone ? "done" : ""].filter(Boolean).join(" ");
    const label = t("plan.dayAria", {
      day: weekdayLong(i), date: dateShort(date), today: isToday ? t("plan.dayAriaToday") : "",
      what: session ? session.focus : t("plan.dayAriaRest"), done: isDone ? t("plan.dayAriaDone") : "",
    });
    const inner = [
      el("span", { class: "dow", text: weekdayShort(i) }),
      el("span", { class: "date", text: String(date.getDate()) }),
      isToday ? el("span", { class: "today-tag", text: t("plan.todayTag") })
        : isDone ? icon("check-circle", { cls: "done-icon" })
          : session ? el("span", { class: "train-dot", "aria-hidden": "true" }) : el("span", { class: "rest-label", text: t("plan.rest") }),
    ];
    return el("li", {}, [session
      ? el("button", { type: "button", class: cls, "aria-label": label, onclick: () => onPick(day) }, inner)
      : el("div", { class: cls, "aria-label": label, role: "img" }, inner)]);
  }));
}

function sessionCard(s, { isToday, isDone, open }) {
  const status = t(isDone ? "plan.status.done" : isToday ? "plan.status.today" : "plan.status.scheduled");
  return el("details", { class: `card session-card${isToday ? " is-today" : ""}`, open, id: `session-${s.day_of_week}` }, [
    el("summary", {}, [
      el("span", { class: `status-icon${isDone ? " done" : ""}`, "aria-hidden": "true" }, [icon(isDone ? "check-circle" : isToday ? "fitness-center" : "calendar-today")]),
      el("span", { class: "session-text" }, [
        el("span", { class: "session-meta-top" }, [
          el("span", { text: `${dayLong(s.day_of_week)} · ${status}` }),
          el("span", { class: "dot-sep", "aria-hidden": "true", text: "·" }),
          el("span", {}, [icon("schedule"), mins(s.estimated_minutes)]),
        ]),
        el("span", { class: "session-title", text: s.focus }),
        el("span", { class: "muted small", text: t("today.exercises", { n: s.exercises.length }) }),
      ]),
      icon("expand-more", { cls: "chev" }),
    ]),
    el("ol", { class: "plan-exercises" }, s.exercises.map((ex, i) => el("li", {}, [
      el("span", { class: "num", text: String(i + 1) }),
      el("div", { class: "ex-body" }, [
        el("p", { class: "ex-name", text: ex.name }),
        el("p", { class: "ex-sub" }, [
          ex.rest_seconds ? el("span", { text: t("plan.restSec", { n: ex.rest_seconds }) }) : null,
          ex.target_rpe ? el("span", { text: t("plan.rpe", { n: ex.target_rpe }) }) : null,
          ex.notes ? el("span", { class: "tag", text: ex.notes }) : null,
        ]),
      ]),
      el("span", { class: "ex-spec", text: exerciseSpec(ex, getLang()) }),
    ]))),
    el("div", { class: "session-actions" }, [
      primaryBtn(t("today.start"), "play-arrow", () => startSession(s, isToday), "btn-block"),
      secondaryBtn(t("plan.swap"), "swap-horiz", () => actions.openCoach({ prefill: t("send.swap", { day: dayLong(s.day_of_week), focus: s.focus }) }), "btn-block"),
    ]),
  ]);
}

export function renderPlan(root, d) {
  const plan = d.plan;
  if (!plan) {
    root.replaceChildren(
      el("header", { class: "page-head" }, [el("h1", { text: t("plan.title") })]),
      card("", [emptyState("event-note", t("plan.emptyTitle"), t("plan.emptyText"), primaryBtn(t("today.createPlan"), "add", createPlan))]),
    );
    return;
  }
  const sessions = sortedSessions(plan);
  const byDay = new Map(sessions.map((s) => [s.day_of_week, s]));
  const monday = addDays(parseDate(d.today), -((parseDate(d.today).getDay() + 6) % 7));
  const done = new Set((d.week && d.week.workout_dates) || []);
  const todayIdx = weekdayIndex(d.weekday);
  const openDay = byDay.has(d.weekday) ? d.weekday : (sessions.find((s) => weekdayIndex(s.day_of_week) > todayIdx) || sessions[0]).day_of_week;
  const cards = sessions.map((s) => {
    const iso = isoDate(addDays(monday, weekdayIndex(s.day_of_week)));
    return sessionCard(s, { isToday: s.day_of_week === d.weekday, isDone: done.has(iso), open: s.day_of_week === openDay });
  });
  const pick = (day) => {
    const target = document.getElementById(`session-${day}`);
    if (!target) return;
    target.open = true;
    target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    target.querySelector("summary").focus({ preventScroll: true });
  };
  root.replaceChildren(
    el("header", { class: "page-head" }, [
      el("h1", { text: t("plan.title") }),
      el("p", { class: "muted" }, [plan.title, el("span", { class: "dot-sep", "aria-hidden": "true", text: " · " }), el("span", { class: "accent", text: t("plan.perWeek", { n: sessions.length }) })]),
    ]),
    weekStrip(d, byDay, pick),
    el("div", { class: "dash-grid plan-grid" }, [
      el("div", { class: "session-list" }, cards),
      el("div", { class: "plan-side" }, [
        plan.progression_notes ? card("tip progression", [
          el("span", { class: "tip-icon", "aria-hidden": "true" }, [icon("trending-up")]),
          el("div", { class: "tip-body" }, [el("p", { class: "eyebrow accent", text: t("plan.progression") }), el("p", { class: "tip-text", text: plan.progression_notes })]),
        ]) : null,
        el("button", { type: "button", class: "btn btn-outline btn-center", onclick: () => actions.openCoach({ prefill: t("send.adjust") }) }, [icon("smart-toy"), t("plan.adjust")]),
      ]),
    ]),
  );
}
