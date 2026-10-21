// Pure, DOM-free helpers (easy to test with `node`): onboarding message,
// coach tip, exercise parsing, greetings and suggestion chips. Functions that
// produce text take a `lang` ("en" | "zh") argument.
import { translate, segments, num, grams, kcal, mins } from "./i18n.js";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export const GOALS = [
  { value: "fat_loss", icon: "trending-down" },
  { value: "muscle_gain", icon: "fitness-center" },
  { value: "recomposition", icon: "balance" },
  { value: "general_fitness", icon: "directions-run" },
];

// Values are the backend `Equipment` literals (fitness_core/models.py).
export const EQUIPMENT = [
  "bodyweight", "dumbbells", "kettlebell", "resistance_bands", "pull_up_bar", "bench", "barbell",
  "cable_machine", "weight_machines", "treadmill", "stationary_bike", "rowing_machine", "jump_rope",
];

// Values are the backend `InjuryArea` literals.
export const INJURY_AREAS = ["knee", "lower_back", "shoulder", "wrist", "ankle", "hip", "elbow", "neck"];

export const DIET_PREFERENCES = ["vegetarian", "vegan", "pescatarian", "halal", "kosher", "low_carb", "dairy_free", "gluten_free"];

export const MEAL_ICONS = { breakfast: "egg-alt", lunch: "lunch-dining", dinner: "dinner-dining", snack: "cookie" };

const clean = (s) => String(s ?? "").trim().replace(/\s+/g, " ").replace(/[;；]+/g, ",");

/**
 * Composes the single chat message sent after onboarding, in the UI
 * language, so the coach (not the browser) writes the profile with its tools.
 */
export function buildOnboardingMessage(answers, lang = "en") {
  const a = answers || {};
  const tr = (key, params) => translate(lang, key, params);
  const lower = (s) => (lang === "en" ? s.toLowerCase() : s);
  const sep = tr("obmsg.listSep");
  const none = tr("obmsg.none");
  const equipment = (a.equipment || []).map((v) => lower(tr(`equip.${v}`)));
  const areas = (a.injury_areas || []).map((v) => lower(tr(`injury.${v}`)));
  const injuryNotes = clean(a.injury_notes);
  let injuries = areas.join(sep);
  if (injuryNotes) injuries = injuries ? tr("obmsg.notes", { areas: injuries, notes: injuryNotes }) : injuryNotes;
  const diet = [...(a.dietary_preferences || []).map((d) => lower(tr(`diet.${d}`))), clean(a.diet_notes)].filter(Boolean);
  const allergies = clean(a.allergies);
  const fields = [
    tr("obmsg.goal", { v: lower(tr(`goal.${a.goal}`)) }),
    tr("obmsg.sex", { v: lower(tr(`sex.${a.sex}`)) }),
    tr("obmsg.age", { v: a.age }),
    tr("obmsg.height", { v: a.height_cm }),
    tr("obmsg.weight", { v: a.weight_kg }),
    tr("obmsg.training", { days: a.days_per_week, min: a.minutes_per_session }),
    tr("obmsg.equipment", { v: equipment.length ? equipment.join(sep) : tr("obmsg.bodyweight") }),
    tr("obmsg.injuries", { v: injuries || none }),
    tr("obmsg.diet", { v: diet.length ? diet.join(sep) : none }),
    tr("obmsg.allergies", { v: allergies || none }),
    tr("obmsg.timezone", { v: a.timezone || "UTC" }),
  ];
  return `${tr("obmsg.intro")}${fields.join(tr("obmsg.sep"))}${tr("obmsg.outro")}`;
}

/** Validates one onboarding step; returns {field: message} (empty when valid). */
export function validateOnboardingStep(step, a, lang = "en") {
  const errors = {};
  const tr = (key) => translate(lang, key);
  const n = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
  if (step === 0) {
    if (!a.sex) errors.sex = tr("err.sex");
    const age = n(a.age);
    if (!Number.isInteger(age) || age < 16 || age > 90) errors.age = tr("err.age");
    const h = n(a.height_cm);
    if (!(h >= 120 && h <= 230)) errors.height_cm = tr("err.height");
    const w = n(a.weight_kg);
    if (!(w >= 30 && w <= 250)) errors.weight_kg = tr("err.weight");
  } else if (step === 1) {
    if (!a.goal) errors.goal = tr("err.goal");
  } else if (step === 2) {
    const d = n(a.days_per_week);
    if (!(d >= 1 && d <= 7)) errors.days_per_week = tr("err.days");
    const m = n(a.minutes_per_session);
    if (!(m >= 15 && m <= 120)) errors.minutes_per_session = tr("err.minutes");
  }
  return errors;
}

export function greetingFor(hour, lang = "en") {
  const key = hour >= 5 && hour < 12 ? "morning" : hour >= 12 && hour < 18 ? "afternoon" : "evening";
  return translate(lang, `greet.${key}`);
}

/** Best-effort first name from /api/me (given_name/name if present, else the e-mail). */
export function firstName(me) {
  if (!me) return "";
  if (me.given_name) return String(me.given_name).trim();
  if (me.name) return String(me.name).trim().split(/\s+/)[0];
  const local = String(me.email || "").split("@")[0].split(/[._+-]/)[0];
  return /^[a-z]{2,}$/i.test(local) ? local[0].toUpperCase() + local.slice(1).toLowerCase() : "";
}

export function initials(me) {
  const source = (me && (me.name || me.given_name)) || (me && me.email ? me.email.split("@")[0] : "");
  const words = String(source).split(/[\s._+-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Which meal to suggest adding next, based on the hour and what's logged. */
export function nextMealType(mealsToday, hour) {
  const logged = new Set((mealsToday || []).map((m) => m.meal_type));
  const order = ["breakfast", "lunch", "dinner"];
  const start = hour < 11 ? 0 : hour < 16 ? 1 : 2;
  for (let i = start; i < order.length; i++) if (!logged.has(order[i])) return order[i];
  return "snack";
}

/** Splits "Goblet Box Squat 3x10 (knee-safe)" into name, spec and note. */
export function parseExercise(text) {
  let rest = String(text ?? "").trim();
  let note = "";
  const paren = rest.match(/^(.*?)\s*[(（]([^()（）]*)[)）]\s*$/);
  if (paren && paren[1]) { rest = paren[1]; note = paren[2].trim(); }
  const m = rest.match(/^(.*?)[\s,:–-]*?(\d+\s*[x×]\s*\d+(?:\s*-\s*\d+)?\s*(?:s|sec|secs|seconds|min|mins|reps?)?(?:\s*(?:\/|per|each)\s*[a-z]+)?)\s*$/i);
  if (!m || !m[1].trim()) return { name: rest, spec: "", note };
  const spec = m[2].replace(/\s*[x×]\s*/i, " × ").replace(/\s+/g, " ").trim();
  return { name: m[1].replace(/[\s,:–-]+$/, "").trim(), spec, note };
}

/** "3 × 10", "3 × 30s" / "3 × 30 秒" or "3 sets" for a planned exercise. */
export function exerciseSpec(ex, lang = "en") {
  if (!ex) return "";
  if (ex.reps) return `${ex.sets} × ${ex.reps}`;
  if (ex.duration_seconds) return `${ex.sets} × ${translate(lang, "unit.sec", { n: ex.duration_seconds })}`;
  return translate(lang, "logic.p0Sets", { p0: ex.sets });
}

/** Short label for a session focus in a week strip ("Upper Body Push" -> "Upper"). */
export function shortFocus(focus) {
  const word = String(focus || "").trim().split(/[\s·/,–-]+/)[0] || "–";
  if (/[\u3400-\u9fff]/.test(word)) return word.length > 3 ? word.slice(0, 2) : word;
  return word.length > 7 ? word.slice(0, 6) + "." : word;
}

export function weekdayIndex(day) {
  return WEEKDAYS.indexOf(String(day || "").toLowerCase());
}

/** The plan's sessions sorted Monday..Sunday. */
export function sortedSessions(plan) {
  return [...((plan && plan.sessions) || [])].sort((a, b) => weekdayIndex(a.day_of_week) - weekdayIndex(b.day_of_week));
}

/**
 * Deterministic "coach tip" from dashboard data. Returns
 * {parts: [{text, strong}], question} where `question` is what "Ask why" sends.
 */
export function coachTip(d, now = new Date(), lang = "en") {
  const tr = (key, params) => translate(lang, key, params);
  const hour = now.getHours();
  const today = (d && d.nutrition && d.nutrition.today) || {};
  const meals = today.meals_logged || 0;
  const remainingProtein = today.remaining_protein_g;
  const remainingKcal = today.remaining_calories_kcal;
  if (!meals) {
    const meal = tr(`mealLower.${hour < 11 ? "breakfast" : hour < 16 ? "lunch" : "dinner"}`);
    return { parts: segments(tr("tip.noMeals", { meal })), question: tr("tip.noMeals.q", { meal }) };
  }
  if (hour >= 15 && typeof remainingProtein === "number" && remainingProtein > 25) {
    const g = grams(Math.round(remainingProtein), lang);
    return { parts: segments(tr("tip.protein", { g })), question: tr("tip.protein.q", { g }) };
  }
  if (d && d.today_session && !d.today_session_done) {
    const sess = d.today_session;
    return {
      parts: segments(tr("tip.session", { focus: sess.focus, min: mins(sess.estimated_minutes, lang), n: sess.exercises.length })),
      question: tr("tip.session.q", { focus: sess.focus }),
    };
  }
  if (typeof remainingKcal === "number" && remainingKcal < 0) {
    return { parts: segments(tr("tip.over", { kcal: kcal(Math.round(-remainingKcal), lang) })), question: tr("tip.over.q") };
  }
  const streak = (d && d.nutrition && d.nutrition.logging_streak_days) || 0;
  if (streak >= 2) return { parts: segments(tr("tip.streak", { n: num(streak, 0, lang) })), question: tr("send.howWeek") };
  return { parts: segments(tr("tip.onTrack")), question: tr("send.howWeek") };
}

/** Contextual suggestion chips above the composer. */
export function suggestionChips(d, now = new Date(), lang = "en") {
  const tr = (key, params) => translate(lang, key, params);
  const hour = now.getHours();
  const chips = [];
  if (d && d.today_session && !d.today_session_done) {
    chips.push({ label: tr("chip.startWorkout"), send: tr("send.startToday", { focus: d.today_session.focus }) });
  }
  if (hour < 11) chips.push({ label: tr("chip.breakfast"), send: tr("send.breakfast") });
  else if (hour < 16) chips.push({ label: tr("chip.lunch"), send: tr("send.lunch") });
  else chips.push({ label: tr("chip.dinner"), send: tr("send.dinner") });
  chips.push({ label: tr("chip.howWeek"), send: tr("send.howWeek") });
  if (d && d.has_profile && !d.plan) chips.push({ label: tr("chip.createPlan"), send: tr("send.createPlan") });
  chips.push({ label: tr("chip.logWeight"), prefill: tr("send.logWeight") });
  chips.push({ label: tr("chip.review"), send: tr("send.review") });
  return chips;
}

/** Weight change over the visible points and the weekly pace (moving average based). */
export function weightDelta(points) {
  if (!points || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const days = Math.round((Date.parse(last.local_date) - Date.parse(first.local_date)) / 86400000);
  const delta = last.moving_average_kg - first.moving_average_kg;
  return { delta, days, perWeek: days >= 7 ? (delta / days) * 7 : null };
}

/** Localized card title for a confirmation `kind` (falls back to the server title). */
export function confirmationTitle(kind, { replaces = null, serverTitle = "" } = {}, lang = "en") {
  if (kind === "replace_training_plan") return translate(lang, replaces ? "kind.replace_training_plan.replace" : "kind.replace_training_plan");
  const key = `kind.${kind}`;
  const value = translate(lang, key);
  return value === key ? serverTitle || key : value;
}
