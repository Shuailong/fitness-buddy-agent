// Onboarding stepper (Basics -> Goal -> Training -> Food). On finish it hands
// the answers to app.js, which sends ONE chat message built by
// buildOnboardingMessage() so the coach writes the profile with its own tools.
import { $, el, icon } from "./util.js";
import { GOALS, EQUIPMENT, INJURY_AREAS, DIET_PREFERENCES, validateOnboardingStep } from "./logic.js";

const STEPS = ["Basics", "Goal", "Training", "Food"];

let answers;
let step = 0;
let errors = {};
let handlers = { onFinish: () => {}, onSkip: () => {} };
let seq = 0;

function defaults() {
  return {
    sex: "", age: "", height_cm: "", weight_kg: "", goal: "",
    days_per_week: 3, minutes_per_session: 45, equipment: [], injury_areas: [], injury_notes: "",
    dietary_preferences: [], diet_notes: "", allergies: "",
    timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC",
  };
}

const uid = (p) => `${p}-${++seq}`;

function fieldError(name) {
  return errors[name] ? el("p", { class: "field-error", id: `err-${name}`, role: "alert", text: errors[name] }) : null;
}

function section(title, children, right = null) {
  return el("fieldset", { class: "ob-section" }, [
    el("legend", { class: "ob-label" }, [el("span", { text: title }), right ? el("span", { class: "ob-hint", text: right }) : null]),
    ...children,
  ]);
}

function radioGroup(name, options, current, onChange, cls = "segmented") {
  const group = uid(name);
  return el("div", { class: `${cls} radio-group`, role: "radiogroup" }, options.map((o) => {
    const id = uid(name);
    const input = el("input", { type: "radio", name: group, id, value: String(o.value), checked: String(current) === String(o.value), class: "sr-only" });
    input.addEventListener("change", () => onChange(o.value));
    return el("label", { for: id, class: "radio-opt" }, [input, el("span", { class: "radio-face" }, o.face || [o.label])]);
  }));
}

function chipGroup(name, options, selected, onToggle) {
  return el("div", { class: "chip-group" }, options.map((o) => {
    const id = uid(name);
    const input = el("input", { type: "checkbox", id, value: o.value, checked: selected.includes(o.value), class: "sr-only" });
    input.addEventListener("change", () => onToggle(o.value, input.checked));
    return el("label", { for: id, class: "select-chip" }, [input, el("span", { class: "chip-face" }, [icon("check", { cls: "chk" }), o.label])]);
  }));
}

function numberField(name, label, unit, attrs) {
  const id = uid(name);
  const input = el("input", {
    id, type: "number", inputmode: "decimal", value: answers[name], class: "text-input",
    "aria-invalid": errors[name] ? "true" : null, "aria-describedby": errors[name] ? `err-${name}` : null, ...attrs,
  });
  input.addEventListener("input", () => { answers[name] = input.value; });
  return el("div", { class: "field" }, [
    el("label", { for: id, class: "field-label", text: label }),
    el("div", { class: "input-wrap" }, [input, unit ? el("span", { class: "unit", text: unit }) : null]),
    fieldError(name),
  ]);
}

function textField(name, label, placeholder, { multiline = false } = {}) {
  const id = uid(name);
  const input = el(multiline ? "textarea" : "input", { id, class: "text-input", placeholder, maxlength: 300, rows: multiline ? 2 : null });
  input.value = answers[name];
  input.addEventListener("input", () => { answers[name] = input.value; });
  return el("div", { class: "field" }, [el("label", { for: id, class: "field-label", text: label }), input]);
}

const toggle = (key) => (value, on) => {
  const set = new Set(answers[key]);
  if (on) set.add(value); else set.delete(value);
  answers[key] = [...set];
};

function stepBasics() {
  return [
    el("h1", { class: "ob-title", tabindex: "-1", text: "Let's start with the basics" }),
    el("p", { class: "ob-sub", text: "Your coach uses these to estimate your energy needs." }),
    section("Sex", [radioGroup("sex", [{ value: "female", label: "Female" }, { value: "male", label: "Male" }], answers.sex, (v) => { answers.sex = v; }), fieldError("sex")], "Used in the BMR formula"),
    el("div", { class: "field-grid" }, [
      numberField("age", "Age", "years", { min: 16, max: 90, step: 1, inputmode: "numeric" }),
      numberField("height_cm", "Height", "cm", { min: 120, max: 230, step: 0.5 }),
      numberField("weight_kg", "Weight", "kg", { min: 30, max: 250, step: 0.1 }),
    ]),
  ];
}

function stepGoal() {
  return [
    el("h1", { class: "ob-title", tabindex: "-1", text: "What's your goal?" }),
    el("p", { class: "ob-sub", text: "You can change it any time by telling your coach." }),
    section("Goal", [
      radioGroup("goal", GOALS.map((g) => ({
        value: g.value,
        face: [el("span", { class: "goal-icon" }, [icon(g.icon)]), el("span", { class: "goal-text" }, [el("strong", { text: g.title }), el("span", { text: g.desc })]), icon("check-circle", { cls: "goal-check", fill: true })],
      })), answers.goal, (v) => { answers.goal = v; }, "goal-cards"),
      fieldError("goal"),
    ]),
  ];
}

function stepTraining() {
  const minutesId = uid("minutes");
  const valueOut = el("output", { for: minutesId, class: "slider-value" }, [icon("timer"), el("span", { text: `${answers.minutes_per_session} min` })]);
  const slider = el("input", { type: "range", id: minutesId, min: 15, max: 120, step: 5, value: answers.minutes_per_session, class: "slider", "aria-label": "Minutes per session" });
  const paint = () => {
    const pct = ((slider.value - 15) / (120 - 15)) * 100;
    slider.style.setProperty("--fill", `${pct}%`);
    valueOut.querySelector("span").textContent = `${slider.value} min`;
  };
  slider.addEventListener("input", () => { answers.minutes_per_session = Number(slider.value); paint(); });
  paint();
  return [
    el("h1", { class: "ob-title", tabindex: "-1", text: "How do you train?" }),
    el("p", { class: "ob-sub", text: "Your coach builds plans around your schedule and body." }),
    section("Days per week", [
      radioGroup("days", [1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: n, label: String(n) })), answers.days_per_week, (v) => { answers.days_per_week = v; }, "segmented days"),
      fieldError("days_per_week"),
    ]),
    section("Minutes per session", [
      el("div", { class: "slider-card" }, [valueOut, slider, el("div", { class: "slider-scale", "aria-hidden": "true" }, [el("span", { text: "15 min" }), el("span", { text: "120 min" })])]),
      fieldError("minutes_per_session"),
    ], "Includes warm-up"),
    section("Equipment available", [chipGroup("equipment", EQUIPMENT, answers.equipment, toggle("equipment"))], "Select all that apply"),
    section("Injuries or limits", [
      chipGroup("injury", INJURY_AREAS, answers.injury_areas, toggle("injury_areas")),
      textField("injury_notes", "Anything else to know?", "e.g. left knee hurts on deep squats"),
    ]),
    el("p", { class: "disclaimer" }, [icon("shield"), "Not medical advice. For pain or medical conditions, check with a professional."]),
  ];
}

function stepFood() {
  return [
    el("h1", { class: "ob-title", tabindex: "-1", text: "How do you eat?" }),
    el("p", { class: "ob-sub", text: "Meal ideas and estimates will respect these." }),
    section("Dietary preferences", [
      chipGroup("diet", DIET_PREFERENCES.map((p) => ({ value: p, label: p })), answers.dietary_preferences, toggle("dietary_preferences")),
      textField("diet_notes", "Other preferences", "e.g. no pork, prefer Asian food"),
    ], "Optional"),
    section("Allergies", [textField("allergies", "Food allergies", "e.g. peanuts, shellfish")], "Optional"),
    el("p", { class: "disclaimer" }, [icon("info"), "Your coach will confirm your details in chat and calculate your daily targets."]),
  ];
}

function render() {
  const root = $("onboarding-view");
  const body = [stepBasics, stepGoal, stepTraining, stepFood][step]();
  const backBtn = el("button", { type: "button", class: "icon-btn", "aria-label": "Back", hidden: step === 0, onclick: back }, [icon("arrow-back")]);
  const continueBtn = el("button", { type: "submit", class: "btn btn-primary btn-xl btn-block" }, [step === STEPS.length - 1 ? "Finish" : "Continue", icon("arrow-forward")]);
  const form = el("form", { class: "ob-form", novalidate: true }, [
    ...body,
    el("div", { class: "ob-footer" }, [
      continueBtn,
      step > 0 ? el("button", { type: "button", class: "text-btn", onclick: back, text: "Back" }) : null,
    ]),
  ]);
  form.addEventListener("submit", (e) => { e.preventDefault(); next(); });
  root.replaceChildren(el("div", { class: "ob-shell" }, [
    el("header", { class: "ob-top" }, [
      el("div", { class: "ob-top-left" }, [backBtn]),
      el("p", { class: "ob-step", "aria-live": "polite", text: `Step ${step + 1} of ${STEPS.length}` }),
      el("button", { type: "button", class: "text-btn", onclick: () => handlers.onSkip() }, ["Skip – just chat"]),
    ]),
    el("ol", { class: "ob-progress", "aria-label": "Onboarding progress" }, STEPS.map((s, i) => el("li", {
      class: i < step ? "done" : i === step ? "current" : "", "aria-current": i === step ? "step" : null,
    }, [el("span", { class: "seg", "aria-hidden": "true" }), el("span", { class: "seg-label", text: `${i + 1}. ${s}` })]))),
    form,
  ]));
  const firstKey = Object.keys(errors)[0];
  if (firstKey) {
    const err = root.querySelector(`#err-${firstKey}`);
    const field = err && err.closest(".field, .ob-section");
    const input = field && field.querySelector("input");
    if (input) input.focus();
  }
}

function next() {
  errors = validateOnboardingStep(step, answers);
  if (Object.keys(errors).length) { render(); return; }
  if (step < STEPS.length - 1) {
    step += 1;
    render();
    $("onboarding-view").scrollTo?.(0, 0);
    window.scrollTo(0, 0);
    $("onboarding-view").querySelector(".ob-title")?.focus?.();
    return;
  }
  handlers.onFinish({
    ...answers,
    age: Number(answers.age),
    height_cm: Number(answers.height_cm),
    weight_kg: Number(answers.weight_kg),
  });
}

function back() {
  if (step === 0) return;
  errors = {};
  step -= 1;
  render();
}

export function startOnboarding({ onFinish, onSkip }) {
  handlers = { onFinish, onSkip };
  answers = defaults();
  step = 0;
  errors = {};
  render();
}
