// Dashboard views: Today, Progress and Plan (all driven by GET /api/dashboard).
import { el, icon, fmt, signed, humanize, capitalize, parseDate, isoDate, addDays, shortDate, clockTime, clamp, richText, isNum } from "./util.js";
import { calorieRing, miniRing, weightChart, calorieBars } from "./charts.js";
import {
  GOALS, WEEKDAYS, WEEKDAY_SHORT, MEAL_ICONS, coachTip, greetingFor, firstName, nextMealType,
  exerciseSpec, sortedSessions, weekdayIndex, weightDelta,
} from "./logic.js";
import { state, actions } from "./state.js";

const goalLabel = (g) => (GOALS.find((x) => x.value === g) || { label: humanize(g) }).label;

function card(cls, children, attrs = {}) {
  return el("section", { class: `card ${cls}`.trim(), ...attrs }, children);
}

function cardHeader(iconName, title, right = null, { level = "h2" } = {}) {
  return el("div", { class: "card-header" }, [
    el("div", { class: "card-heading" }, [iconName ? icon(iconName, { cls: "accent", fill: iconName === "bolt" }) : null, el(level, { text: title })]),
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
  return el("div", { class: "loading", role: "status" }, [el("span", { class: "spinner", "aria-hidden": "true" }), "Loading..."]);
}

export function errorView(message, retry) {
  return card("", [emptyState("warning", "Couldn't load your data", message, secondaryBtn("Try again", null, retry))]);
}

const startSession = (session, isToday = true) => actions.openCoach({
  send: isToday ? `Start today's workout: ${session.focus}` : `I want to do my ${capitalize(session.day_of_week)} session now: ${session.focus}`,
});
const createPlan = () => actions.openCoach({ send: "Please create a weekly training plan for me." });

// ================================================================== TODAY
function macroBar(name, cls, value, target) {
  const pct = target ? clamp((value / target) * 100, 0, 100) : 0;
  return el("div", { class: `macro ${cls}` }, [
    el("div", { class: "macro-row" }, [
      el("span", { class: "macro-name" }, [el("i", { class: "swatch", "aria-hidden": "true" }), name]),
      el("span", { class: "macro-val" }, [el("b", { text: fmt(value) }), target ? ` / ${fmt(target)}g` : "g"]),
    ]),
    el("div", { class: `bar-track${target && value > target ? " over" : ""}`, role: "progressbar", "aria-label": name, "aria-valuemin": 0, "aria-valuemax": target || 0, "aria-valuenow": Math.round(value || 0) }, [
      el("span", { style: { width: `${pct}%` } }),
    ]),
  ]);
}

function heroCard(d) {
  const today = d.nutrition.today;
  const t = d.targets || {};
  const consumed = today.consumed || {};
  const target = today.target_calories_kcal;
  const remaining = today.remaining_calories_kcal;
  let pace = null;
  if (t.daily_calories_kcal && t.tdee_kcal) {
    const diff = t.daily_calories_kcal - t.tdee_kcal;
    pace = diff < -100 ? "Deficit target" : diff > 100 ? "Surplus target" : "Maintenance";
  }
  const left = !isNum(remaining) ? null
    : remaining >= 0 ? el("span", { class: "pill pill-primary", text: `${fmt(remaining)} left` })
      : el("span", { class: "pill pill-warn", text: `${fmt(-remaining)} over` });
  return card("hero", [
    el("div", { class: "glow", "aria-hidden": "true" }),
    cardHeader("bolt", "Caloric balance", pace ? el("span", { class: "tag-muted", text: pace }) : null),
    el("div", { class: "hero-grid" }, [
      el("div", { class: "ring-col" }, [
        el("div", { class: "ring-wrap" }, [
          calorieRing(consumed.calories_kcal || 0, target),
          el("div", { class: "ring-center", "aria-hidden": "true" }, [
            el("span", { class: "ring-value-text", text: fmt(consumed.calories_kcal) }),
            el("span", { class: "ring-sub", text: target ? `of ${fmt(target)} kcal` : "kcal today" }),
          ]),
        ]),
        left,
      ]),
      el("div", { class: "macros" }, [
        macroBar("Protein", "protein", consumed.protein_g || 0, t.protein_g || today.target_protein_g),
        macroBar("Carbs", "carbs", consumed.carbs_g || 0, t.carbs_g),
        macroBar("Fat", "fat", consumed.fat_g || 0, t.fat_g),
      ]),
    ]),
    !target ? el("p", { class: "muted small", text: "Your coach will set daily targets once your profile is complete." }) : null,
  ], { "aria-label": "Caloric balance" });
}

function quickActions() {
  const btn = (iconName, label, onclick) => el("button", { type: "button", class: "quick", onclick }, [icon(iconName, { cls: "accent" }), el("span", { text: label })]);
  return el("div", { class: "quick-actions" }, [
    btn("photo-camera", "Snap a meal", () => actions.openCoach({ photo: "camera" })),
    btn("fitness-center", "Log workout", () => actions.openCoach({ prefill: "I just finished my workout: " })),
    btn("forum", "Ask coach", () => actions.openCoach({ focus: true })),
  ]);
}

function tipCard(d) {
  const tip = coachTip(d, new Date());
  return card("tip", [
    el("span", { class: "tip-icon", "aria-hidden": "true" }, [icon("smart-toy", { fill: true })]),
    el("div", { class: "tip-body" }, [
      el("p", { class: "eyebrow accent", text: "Coach tip" }),
      el("p", { class: "tip-text" }, richText(tip.parts)),
      el("button", { type: "button", class: "link-btn", onclick: () => actions.openCoach({ send: tip.question }) }, ["Ask why", icon("arrow-forward")]),
    ]),
  ], { "aria-label": "Coach tip" });
}

function workoutCard(d) {
  const plan = d.plan;
  if (!plan) {
    return card("workout", [
      cardHeader("fitness-center", "Today's workout"),
      emptyState("event-note", "No training plan yet", "Your coach builds a weekly plan around your schedule, equipment and injuries.", primaryBtn("Create my plan", "add", createPlan)),
    ]);
  }
  const s = d.today_session;
  const sessions = sortedSessions(plan);
  if (!s) {
    const todayIdx = weekdayIndex(d.weekday);
    const next = sessions.find((x) => weekdayIndex(x.day_of_week) > todayIdx) || sessions[0];
    return card("workout rest", [
      cardHeader("hotel", "Rest day"),
      el("p", { class: "muted", text: "Recovery is part of the plan. Light walking or stretching is a good idea." }),
      next ? el("p", { class: "next-up" }, [el("span", { class: "muted", text: "Next session: " }), el("strong", { text: `${capitalize(next.day_of_week)} · ${next.focus}` })]) : null,
      secondaryBtn("View plan", "event-note", () => actions.navigate("plan"), "btn-block"),
    ]);
  }
  const position = sessions.findIndex((x) => x.day_of_week === s.day_of_week) + 1;
  const preview = s.exercises.slice(0, 4);
  const more = s.exercises.length - preview.length;
  return card("workout", [
    el("div", { class: "card-header" }, [
      el("div", {}, [
        el("p", { class: "eyebrow accent", text: `Session ${position} of ${sessions.length} this week` }),
        el("h2", { class: "workout-title", text: s.focus }),
      ]),
      d.today_session_done ? el("span", { class: "pill pill-primary" }, [icon("check"), "Done"]) : el("span", { class: "round-icon", "aria-hidden": "true" }, [icon("calendar-today")]),
    ]),
    el("div", { class: "meta-row" }, [
      el("span", {}, [icon("schedule", { cls: "accent" }), `${s.estimated_minutes} min`]),
      el("span", { class: "sep", "aria-hidden": "true", text: "•" }),
      el("span", {}, [icon("fitness-center", { cls: "accent" }), `${s.exercises.length} exercises`]),
    ]),
    el("ol", { class: "ex-preview" }, preview.map((ex, i) => el("li", {}, [
      el("span", { class: "num", text: String(i + 1) }),
      el("span", { class: "ex-name", text: ex.name }),
      el("span", { class: "ex-spec", text: exerciseSpec(ex) }),
    ]))),
    more > 0 ? el("button", { type: "button", class: "link-btn", onclick: () => actions.navigate("plan") }, [`+${more} more in your plan`, icon("chevron-right")]) : null,
    d.today_session_done
      ? secondaryBtn("Session logged. View plan", "check-circle", () => actions.navigate("plan"), "btn-block")
      : primaryBtn("Start session", "play-arrow", () => startSession(s), "btn-block"),
  ], { "aria-label": "Today's workout" });
}

function mealsCard(d) {
  const meals = d.nutrition.meals_today || [];
  const hour = new Date().getHours();
  const next = nextMealType(meals, hour);
  const total = meals.reduce((sum, m) => sum + ((m.totals && m.totals.calories_kcal) || 0), 0);
  return el("section", { class: "meals", "aria-label": "Meals today" }, [
    el("div", { class: "section-header" }, [
      el("h2", { text: "Meals today" }),
      el("span", { class: "muted small", text: meals.length ? `${meals.length} logged · ${fmt(total)} kcal` : "Nothing logged yet" }),
    ]),
    el("ul", { class: "meal-list" }, meals.map((m) => el("li", { class: "meal-row" }, [
      el("span", { class: `meal-icon ${m.meal_type}`, "aria-hidden": "true" }, [icon(MEAL_ICONS[m.meal_type] || "restaurant")]),
      el("div", { class: "meal-text" }, [
        el("p", { class: "meal-name", text: (m.items || []).join(", ") || capitalize(m.meal_type) }),
        el("p", { class: "meal-meta", text: `${capitalize(m.meal_type)} · ${clockTime(m.logged_at, d.timezone)}` }),
      ]),
      el("div", { class: "meal-kcal" }, [el("b", { text: fmt(m.totals && m.totals.calories_kcal) }), el("span", { text: "kcal" })]),
    ]))),
    el("button", { type: "button", class: "add-row", onclick: () => actions.openCoach({ photo: "camera" }) }, [icon("add-circle"), `Add ${next}`]),
  ]);
}

function weightMiniCard(d) {
  const pts = d.weight.points || [];
  const delta = weightDelta(pts);
  return card("weight-mini desktop-only", [
    cardHeader("trending-down", "Weight trend", el("span", { class: "muted small", text: `Last ${d.range_days} days` })),
    pts.length ? el("div", { class: "big-number" }, [
      el("span", { class: "num", text: fmt(d.weight.latest_weight_kg, 1) }), el("span", { class: "unit", text: "kg" }),
      delta ? el("span", { class: "delta", text: `${signed(delta.delta)} kg` }) : null,
    ]) : null,
    pts.length > 1 ? weightChart(pts, { compact: true, height: 120 }) : el("p", { class: "muted", text: "Log your weight in Coach to see your trend." }),
    secondaryBtn("See progress", "monitoring", () => actions.navigate("progress"), "btn-block"),
  ]);
}

export function renderToday(root, d) {
  const now = new Date();
  const name = firstName(state.me);
  const dateLabel = parseDate(d.today).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const streak = d.nutrition.logging_streak_days || 0;
  root.replaceChildren(
    el("header", { class: "greeting" }, [
      el("div", { class: "greeting-row" }, [
        el("h1", { text: `${greetingFor(now.getHours())}${name ? `, ${name}` : ""}` }),
        el("span", { class: "date", text: dateLabel }),
      ]),
      el("div", { class: "chips" }, [
        el("span", { class: "chip" }, [icon("target", { cls: "accent", fill: true }), "Goal: ", el("strong", { text: goalLabel(d.goal) })]),
        streak > 0 ? el("span", { class: "chip" }, [icon("local-fire-department", { cls: "streak", fill: true }), `${streak}-day logging streak`]) : null,
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
  const opts = [[14, "2W"], [30, "1M"], [90, "3M"]];
  return el("div", { class: "segmented", role: "group", "aria-label": "Weight chart range" }, opts.map(([v, label]) =>
    el("button", { type: "button", class: v === current ? "active" : "", "aria-pressed": String(v === current), onclick: () => onChange(v) }, [label])));
}

function weightCard(d) {
  const w = d.weight;
  const pts = w.points || [];
  const delta = weightDelta(pts);
  if (pts.length < 2) {
    return card("weight", [
      cardHeader("monitor-weight", "Weight trend"),
      emptyState("monitor-weight", pts.length ? "One weigh-in so far" : "No weigh-ins yet",
        "Log your weight in Coach (for example \u201c81.5 kg this morning\u201d) to see your 7-day trend.",
        secondaryBtn("Log weight", "add", () => actions.openCoach({ prefill: "My weight this morning: " }))),
    ]);
  }
  const trendIcon = delta.delta < -0.05 ? "trending-down" : delta.delta > 0.05 ? "trending-up" : "trending-flat";
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => pts[Math.round(f * (pts.length - 1))]);
  return card("weight", [
    el("div", { class: "weight-head" }, [
      el("div", {}, [
        el("p", { class: "eyebrow", text: "Current weight" }),
        el("p", { class: "big-number" }, [el("span", { class: "num", text: fmt(w.latest_weight_kg, 1) }), el("span", { class: "unit", text: "kg" })]),
      ]),
      el("div", { class: "weight-delta" }, [
        el("span", { class: "pill pill-primary" }, [icon(trendIcon), `${signed(delta.delta)} kg in ${delta.days}d`]),
        isNum(delta.perWeek) ? el("span", { class: "muted small", text: `${signed(delta.perWeek)} kg/wk average` }) : null,
      ]),
    ]),
    weightChart(pts, window.matchMedia("(min-width: 1024px)").matches ? { width: 800, height: 240 } : {}),
    el("div", { class: "x-labels", "aria-hidden": "true" }, [...new Set(xLabels)].map((p, i, arr) => el("span", { text: i === arr.length - 1 && p.local_date === d.today ? "Today" : shortDate(p.local_date) }))),
    el("div", { class: "legend" }, [
      el("span", {}, [el("i", { class: "lg-dot" }), "Daily weigh-in"]),
      el("span", {}, [el("i", { class: "lg-line" }), "7-day average"]),
    ]),
  ], { "aria-label": "Weight trend" });
}

function caloriesCard(d) {
  const n = d.nutrition;
  const target = (d.targets && d.targets.daily_calories_kcal) || null;
  const logged = n.days.filter((x) => x.meals_logged > 0);
  const avg = logged.length ? logged.reduce((s, x) => s + x.calories_kcal, 0) / logged.length : null;
  return card("calories", [
    cardHeader(null, "Calories & fuel", target ? el("span", { class: "pill pill-outline", text: `Target: ${fmt(target)}` }) : null),
    el("p", { class: "muted small sub", text: `Last ${n.days.length} days` }),
    logged.length ? calorieBars(n.days, target) : emptyState("restaurant", "No meals logged yet", "Snap a meal in Coach and your daily calories will show up here."),
    logged.length ? el("div", { class: "chart-foot" }, [
      el("span", { class: "muted", text: `${n.days.length}d ago` }),
      el("span", { class: "strong", text: `Avg ${fmt(avg)} kcal · ${logged.length}/${n.days.length} days logged` }),
      el("span", { class: "muted", text: "Today" }),
    ]) : null,
  ], { "aria-label": "Calories versus target" });
}

function proteinCard(d) {
  const n = d.nutrition;
  const goal = (d.targets && d.targets.protein_g) || null;
  const rate = n.days.length ? Math.round((n.protein_hit_days / n.days.length) * 100) : 0;
  return card("protein", [
    cardHeader(null, "Protein consistency", icon("restaurant", { cls: "accent" })),
    el("p", { class: "muted small sub", text: goal ? `Daily goal: ${fmt(goal)} g` : "Daily goal not set yet" }),
    el("ol", { class: "hit-grid", "aria-label": "Protein target by day, oldest first" }, n.days.map((day) => {
      const status = !day.meals_logged ? "none" : day.protein_target_hit ? "hit" : "miss";
      const label = `${shortDate(day.local_date)}: ${status === "none" ? "not logged" : status === "hit" ? `hit (${fmt(day.protein_g)} g)` : `missed (${fmt(day.protein_g)} g)`}`;
      return el("li", { class: `hit is-${status}`, title: label }, [
        status === "hit" ? icon("check") : status === "miss" ? icon("close") : el("span", { "aria-hidden": "true", text: "–" }),
        el("span", { class: "sr-only", text: label }),
      ]);
    })),
    el("div", { class: "card-foot" }, [
      el("span", { text: `Hit ${n.protein_hit_days} of ${n.days.length} days` }),
      el("span", { class: "accent strong", text: `${rate}% rate` }),
    ]),
  ], { "aria-label": "Protein consistency" });
}

function workoutsCard(d) {
  const wk = d.week;
  const planned = wk.planned_sessions || 0;
  const done = wk.completed_sessions || 0;
  const hist = wk.history || [];
  const maxBar = Math.max(planned, ...hist.map((h) => h.sessions), 1);
  const left = planned - done;
  return card("workouts", [
    cardHeader(null, "Weekly workouts", icon("fitness-center", { cls: "accent" })),
    el("div", { class: "workouts-body" }, [
      el("div", { class: "ring-wrap small" }, [
        miniRing(done, planned || Math.max(done, 1), { label: planned ? `${done} of ${planned} sessions in the last 7 days` : `${done} sessions in the last 7 days` }),
        el("div", { class: "ring-center", "aria-hidden": "true" }, [
          el("span", { class: "ring-value-text sm", text: planned ? `${done}/${planned}` : String(done) }),
          el("span", { class: "ring-sub", text: "sessions" }),
        ]),
      ]),
      el("div", { class: "history" }, [
        el("p", { class: "muted small", text: "Last 4 weeks" }),
        el("ol", { class: "history-bars" }, hist.map((h, i) => {
          const isNow = i === hist.length - 1;
          return el("li", { class: isNow ? "now" : "" }, [
            el("span", { class: "hbar-track" }, [el("span", { class: "hbar", style: { height: `${Math.max(6, (h.sessions / maxBar) * 100)}%` } })]),
            el("span", { class: "hlabel", text: isNow ? "Now" : planned ? `${h.sessions}/${planned}` : String(h.sessions) }),
            el("span", { class: "sr-only", text: `Week ending ${shortDate(h.week_end)}: ${h.sessions} sessions` }),
          ]);
        })),
      ]),
    ]),
    el("div", { class: "card-foot" }, [
      el("span", { text: planned ? `Target: ${planned} sessions/wk` : "No plan yet" }),
      planned ? el("span", { class: "accent strong", text: left > 0 ? `${left} to go` : "Target hit" }) : el("button", { type: "button", class: "link-btn", onclick: createPlan }, ["Create my plan"]),
    ]),
  ], { "aria-label": "Weekly workouts" });
}

function reviewCard(d) {
  const r = d.latest_review;
  if (!r) {
    return card("review tip", [
      el("span", { class: "tip-icon", "aria-hidden": "true" }, [icon("smart-toy", { fill: true })]),
      el("div", { class: "tip-body" }, [
        el("p", { class: "eyebrow accent", text: "Weekly review" }),
        el("p", { class: "tip-text", text: "Your first weekly review arrives after about a week of logging meals, workouts and weigh-ins." }),
      ]),
    ]);
  }
  return card("review tip", [
    el("span", { class: "tip-icon", "aria-hidden": "true" }, [icon("smart-toy", { fill: true })]),
    el("div", { class: "tip-body" }, [
      el("p", { class: "eyebrow accent", text: `Weekly review · ${shortDate(r.week_end)}` }),
      el("p", { class: "tip-text clamp-3", text: r.summary }),
      el("button", { type: "button", class: "link-btn", onclick: () => actions.openCoach({ send: "Show me my latest weekly review." }) }, ["Read full review", icon("arrow-forward")]),
    ]),
  ], { "aria-label": "Weekly review" });
}

export function renderProgress(root, d, onRange) {
  root.replaceChildren(
    el("header", { class: "page-head" }, [el("h1", { text: "Progress" })]),
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
  return el("ol", { class: "week-strip big", "aria-label": "This week" }, WEEKDAYS.map((day, i) => {
    const date = addDays(monday, i);
    const iso = isoDate(date);
    const isToday = iso === d.today;
    const isDone = done.has(iso);
    const session = sessionsByDay.get(day);
    const cls = ["day-pill", session ? "train" : "rest", isToday ? "today" : "", isDone ? "done" : ""].filter(Boolean).join(" ");
    const label = `${capitalize(day)} ${date.getDate()}${isToday ? ", today" : ""}: ${session ? session.focus : "rest day"}${isDone ? ", workout logged" : ""}`;
    const inner = [
      el("span", { class: "dow", text: WEEKDAY_SHORT[i] }),
      el("span", { class: "date", text: String(date.getDate()) }),
      isToday ? el("span", { class: "today-tag", text: "Today" })
        : isDone ? icon("check-circle", { cls: "done-icon" })
          : session ? el("span", { class: "train-dot", "aria-hidden": "true" }) : el("span", { class: "rest-label", text: "Rest" }),
    ];
    return el("li", {}, [session
      ? el("button", { type: "button", class: cls, "aria-label": label, onclick: () => onPick(day) }, inner)
      : el("div", { class: cls, "aria-label": label, role: "img" }, inner)]);
  }));
}

function sessionCard(d, s, { isToday, isDone, open }) {
  const status = isDone ? "Completed" : isToday ? "Today" : "Scheduled";
  const node = el("details", { class: `card session-card${isToday ? " is-today" : ""}`, open, id: `session-${s.day_of_week}` }, [
    el("summary", {}, [
      el("span", { class: `status-icon${isDone ? " done" : ""}`, "aria-hidden": "true" }, [icon(isDone ? "check-circle" : isToday ? "fitness-center" : "calendar-today")]),
      el("span", { class: "session-text" }, [
        el("span", { class: "session-meta-top" }, [
          el("span", { text: `${capitalize(s.day_of_week)} · ${status}` }),
          el("span", { class: "dot-sep", "aria-hidden": "true", text: "·" }),
          el("span", {}, [icon("schedule"), `${s.estimated_minutes} min`]),
        ]),
        el("span", { class: "session-title", text: s.focus }),
        el("span", { class: "muted small", text: `${s.exercises.length} exercises` }),
      ]),
      icon("expand-more", { cls: "chev" }),
    ]),
    el("ol", { class: "plan-exercises" }, s.exercises.map((ex, i) => el("li", {}, [
      el("span", { class: "num", text: String(i + 1) }),
      el("div", { class: "ex-body" }, [
        el("p", { class: "ex-name", text: ex.name }),
        el("p", { class: "ex-sub" }, [
          ex.rest_seconds ? el("span", { text: `${ex.rest_seconds}s rest` }) : null,
          ex.target_rpe ? el("span", { text: `RPE ${ex.target_rpe}` }) : null,
          ex.notes ? el("span", { class: "tag", text: ex.notes }) : null,
        ]),
      ]),
      el("span", { class: "ex-spec", text: exerciseSpec(ex) }),
    ]))),
    el("div", { class: "session-actions" }, [
      primaryBtn("Start session", "play-arrow", () => startSession(s, isToday), "btn-block"),
      secondaryBtn("Ask coach to swap", "swap-horiz", () => actions.openCoach({ prefill: `Please swap an exercise in my ${capitalize(s.day_of_week)} session (${s.focus}): ` }), "btn-block"),
    ]),
  ]);
  return node;
}

export function renderPlan(root, d) {
  const plan = d.plan;
  if (!plan) {
    root.replaceChildren(
      el("header", { class: "page-head" }, [el("h1", { text: "Your plan" })]),
      card("", [emptyState("event-note", "No plan yet",
        "Tell your coach how many days you can train and what equipment you have, and it will build a weekly plan for you.",
        primaryBtn("Create my plan", "add", createPlan))]),
    );
    return;
  }
  const sessions = sortedSessions(plan);
  const byDay = new Map(sessions.map((s) => [s.day_of_week, s]));
  const todayIso = d.today;
  const monday = addDays(parseDate(todayIso), -((parseDate(todayIso).getDay() + 6) % 7));
  const done = new Set((d.week && d.week.workout_dates) || []);
  const todayIdx = weekdayIndex(d.weekday);
  const openDay = byDay.has(d.weekday) ? d.weekday : (sessions.find((s) => weekdayIndex(s.day_of_week) > todayIdx) || sessions[0]).day_of_week;
  const cards = sessions.map((s) => {
    const iso = isoDate(addDays(monday, weekdayIndex(s.day_of_week)));
    return sessionCard(d, s, { isToday: s.day_of_week === d.weekday, isDone: done.has(iso), open: s.day_of_week === openDay });
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
      el("h1", { text: "Your plan" }),
      el("p", { class: "muted" }, [plan.title, el("span", { class: "dot-sep", "aria-hidden": "true", text: " · " }), el("span", { class: "accent", text: `${sessions.length} sessions/week` })]),
    ]),
    weekStrip(d, byDay, pick),
    el("div", { class: "dash-grid plan-grid" }, [
      el("div", { class: "session-list" }, cards),
      el("div", { class: "plan-side" }, [
        plan.progression_notes ? card("tip progression", [
          el("span", { class: "tip-icon", "aria-hidden": "true" }, [icon("trending-up")]),
          el("div", { class: "tip-body" }, [el("p", { class: "eyebrow accent", text: "Progression note" }), el("p", { class: "tip-text", text: plan.progression_notes })]),
        ]) : null,
        el("button", { type: "button", class: "btn btn-outline btn-center", onclick: () => actions.openCoach({ prefill: "Please adjust my training plan: " }) }, [icon("smart-toy"), "Ask coach to adjust plan"]),
      ]),
    ]),
  );
}
