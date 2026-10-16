// Pure, DOM-free helpers (easy to test with `node`): onboarding message,
// coach tip, exercise parsing, greetings and suggestion chips.

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const GOALS = [
  { value: "fat_loss", label: "Fat loss", title: "Lose fat", desc: "Steady deficit while keeping muscle", icon: "trending-down" },
  { value: "muscle_gain", label: "Muscle gain", title: "Build muscle", desc: "Small surplus and progressive training", icon: "fitness-center" },
  { value: "recomposition", label: "Recomposition", title: "Recomposition", desc: "Lose fat and build muscle slowly", icon: "balance" },
  { value: "general_fitness", label: "General fitness", title: "General fitness", desc: "Move more, feel better, stay consistent", icon: "directions-run" },
];

// Values are the backend `Equipment` literals (fitness_core/models.py).
export const EQUIPMENT = [
  { value: "bodyweight", label: "Bodyweight only" },
  { value: "dumbbells", label: "Dumbbells" },
  { value: "kettlebell", label: "Kettlebell" },
  { value: "resistance_bands", label: "Resistance bands" },
  { value: "pull_up_bar", label: "Pull-up bar" },
  { value: "bench", label: "Bench" },
  { value: "barbell", label: "Barbell" },
  { value: "cable_machine", label: "Cable machine" },
  { value: "weight_machines", label: "Weight machines" },
  { value: "treadmill", label: "Treadmill" },
  { value: "stationary_bike", label: "Stationary bike" },
  { value: "rowing_machine", label: "Rowing machine" },
  { value: "jump_rope", label: "Jump rope" },
];

// Values are the backend `InjuryArea` literals.
export const INJURY_AREAS = [
  { value: "knee", label: "Knee" },
  { value: "lower_back", label: "Lower back" },
  { value: "shoulder", label: "Shoulder" },
  { value: "wrist", label: "Wrist" },
  { value: "ankle", label: "Ankle" },
  { value: "hip", label: "Hip" },
  { value: "elbow", label: "Elbow" },
  { value: "neck", label: "Neck" },
];

export const DIET_PREFERENCES = [
  "Vegetarian", "Vegan", "Pescatarian", "Halal", "Kosher", "Low carb", "Dairy-free", "Gluten-free",
];

export const MEAL_ICONS = { breakfast: "egg-alt", lunch: "lunch-dining", dinner: "dinner-dining", snack: "cookie" };

const labelOf = (list, value) => (list.find((x) => x.value === value) || { label: String(value).replace(/_/g, " ") }).label;
const clean = (s) => String(s ?? "").trim().replace(/\s+/g, " ").replace(/[;]+/g, ",");
const joinOrNone = (items) => (items.length ? items.join(", ") : "none");

/**
 * Composes the single plain-English chat message sent after onboarding, so
 * the coach (not the browser) writes the profile through its own tools.
 */
export function buildOnboardingMessage(answers) {
  const a = answers || {};
  const equipment = (a.equipment || []).map((v) => labelOf(EQUIPMENT, v).toLowerCase());
  const areas = (a.injury_areas || []).map((v) => labelOf(INJURY_AREAS, v).toLowerCase());
  const injuryNotes = clean(a.injury_notes);
  let injuries = areas.join(", ");
  if (injuryNotes) injuries = injuries ? `${injuries} (${injuryNotes})` : injuryNotes;
  const diet = [...(a.dietary_preferences || []).map((d) => String(d).toLowerCase()), clean(a.diet_notes)].filter(Boolean);
  const allergies = clean(a.allergies);
  const fields = [
    `goal: ${labelOf(GOALS, a.goal).toLowerCase()}`,
    `sex: ${a.sex}`,
    `age: ${a.age}`,
    `height: ${a.height_cm} cm`,
    `weight: ${a.weight_kg} kg`,
    `training: ${a.days_per_week} days/week, ${a.minutes_per_session} min per session`,
    `equipment: ${equipment.length ? equipment.join(", ") : "bodyweight only"}`,
    `injuries: ${injuries || "none"}`,
    `dietary preferences: ${joinOrNone(diet)}`,
    `allergies: ${allergies || "none"}`,
    `timezone: ${a.timezone || "UTC"}`,
  ];
  return `Here are my onboarding details: ${fields.join("; ")}. Please set up my profile and daily targets.`;
}

/** Validates one onboarding step; returns {field: message} (empty when valid). */
export function validateOnboardingStep(step, a) {
  const errors = {};
  const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
  if (step === 0) {
    if (!a.sex) errors.sex = "Choose one.";
    const age = num(a.age);
    if (!Number.isInteger(age) || age < 16 || age > 90) errors.age = "Enter an age from 16 to 90.";
    const h = num(a.height_cm);
    if (!(h >= 120 && h <= 230)) errors.height_cm = "Enter a height from 120 to 230 cm.";
    const w = num(a.weight_kg);
    if (!(w >= 30 && w <= 250)) errors.weight_kg = "Enter a weight from 30 to 250 kg.";
  } else if (step === 1) {
    if (!a.goal) errors.goal = "Pick the goal that fits best.";
  } else if (step === 2) {
    const d = num(a.days_per_week);
    if (!(d >= 1 && d <= 7)) errors.days_per_week = "Choose 1 to 7 days.";
    const m = num(a.minutes_per_session);
    if (!(m >= 15 && m <= 120)) errors.minutes_per_session = "Choose 15 to 120 minutes.";
  }
  return errors;
}

export function greetingFor(hour) {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
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
  const paren = rest.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (paren && paren[1]) { rest = paren[1]; note = paren[2].trim(); }
  const m = rest.match(/^(.*?)[\s,:–-]*?(\d+\s*[x×]\s*\d+(?:\s*-\s*\d+)?\s*(?:s|sec|secs|seconds|min|mins|reps?)?(?:\s*(?:\/|per|each)\s*[a-z]+)?)\s*$/i);
  if (!m || !m[1].trim()) return { name: rest, spec: "", note };
  const spec = m[2].replace(/\s*[x×]\s*/i, " × ").replace(/\s+/g, " ").trim();
  return { name: m[1].replace(/[\s,:–-]+$/, "").trim(), spec, note };
}

/** "3 × 10", "3 × 30s" or "3 sets" for a planned exercise. */
export function exerciseSpec(ex) {
  if (!ex) return "";
  if (ex.reps) return `${ex.sets} × ${ex.reps}`;
  if (ex.duration_seconds) return `${ex.sets} × ${ex.duration_seconds}s`;
  return `${ex.sets} sets`;
}

/** Short label for a session focus in a week strip ("Upper Body Push" -> "Upper"). */
export function shortFocus(focus) {
  const word = String(focus || "").trim().split(/[\s·/,–-]+/)[0] || "Train";
  return word.length > 7 ? word.slice(0, 6) + "." : word;
}

export function weekdayIndex(day) {
  return WEEKDAYS.indexOf(String(day || "").toLowerCase());
}

/** The plan's sessions sorted Monday..Sunday. */
export function sortedSessions(plan) {
  return [...((plan && plan.sessions) || [])].sort((a, b) => weekdayIndex(a.day_of_week) - weekdayIndex(b.day_of_week));
}

const s = (text, strong = false) => ({ text, strong });
const round = (n) => Math.round(Number(n) || 0);

/**
 * Deterministic "coach tip" from dashboard data. Returns
 * {parts: [{text, strong}], question} where `question` is what "Ask why" sends.
 */
export function coachTip(d, now = new Date()) {
  const hour = now.getHours();
  const today = (d && d.nutrition && d.nutrition.today) || {};
  const meals = today.meals_logged || 0;
  const remainingProtein = today.remaining_protein_g;
  const remainingKcal = today.remaining_calories_kcal;
  if (!meals) {
    const meal = hour < 11 ? "breakfast" : hour < 16 ? "lunch" : "dinner";
    return {
      parts: [s("Nothing logged yet today. "), s(`Snap your ${meal}`, true), s(" and I'll estimate calories and protein from the photo.")],
      question: `What would be a good ${meal} for my goal today?`,
    };
  }
  if (hour >= 15 && typeof remainingProtein === "number" && remainingProtein > 25) {
    return {
      parts: [s("You're "), s(`${round(remainingProtein)} g short`, true), s(" on protein. A lean protein source at your next meal would close the gap.")],
      question: `I'm ${round(remainingProtein)} g short on protein today. What should I eat to close the gap?`,
    };
  }
  if (d && d.today_session && !d.today_session_done) {
    const sess = d.today_session;
    return {
      parts: [s("Today is "), s(`${sess.focus}`, true), s(` day: about ${sess.estimated_minutes} min, ${sess.exercises.length} exercises.`)],
      question: `Any tips for today's ${sess.focus} session?`,
    };
  }
  if (typeof remainingKcal === "number" && remainingKcal < 0) {
    return {
      parts: [s("You're "), s(`${round(-remainingKcal)} kcal over`, true), s(" today. No stress: one day doesn't change the trend. Keep tomorrow steady.")],
      question: "I went over my calories today. What should I do tomorrow?",
    };
  }
  const streak = (d && d.nutrition && d.nutrition.logging_streak_days) || 0;
  if (streak >= 2) {
    return {
      parts: [s(`${streak}-day logging streak`, true), s(". Consistency is what moves the trend, keep it going.")],
      question: "How am I doing this week?",
    };
  }
  return {
    parts: [s("You're on track today. "), s("Keep logging", true), s(" and I'll keep your numbers honest.")],
    question: "How am I doing this week?",
  };
}

/** Contextual suggestion chips above the composer. */
export function suggestionChips(d, now = new Date()) {
  const hour = now.getHours();
  const chips = [];
  if (d && d.today_session && !d.today_session_done) {
    chips.push({ label: "Start today's workout", send: `Start today's workout: ${d.today_session.focus}` });
  }
  if (hour < 11) chips.push({ label: "High-protein breakfast ideas?", send: "What's a good high-protein breakfast for my goal?" });
  else if (hour < 16) chips.push({ label: "What should I eat for lunch?", send: "What should I eat for lunch?" });
  else chips.push({ label: "What should I eat for dinner?", send: "What should I eat for dinner?" });
  chips.push({ label: "How am I doing this week?", send: "How am I doing this week?" });
  if (d && d.has_profile && !d.plan) chips.push({ label: "Create my weekly plan", send: "Please create a weekly training plan for me." });
  chips.push({ label: "Log my weight", prefill: "My weight this morning: " });
  chips.push({ label: "Weekly review", send: "Show me my latest weekly review." });
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
