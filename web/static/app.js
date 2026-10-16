// Fitness Buddy web client: vanilla JS ES modules, no build step.
// Talks to the FastAPI backend in web/main.py (SSE over fetch for chat).
import { $, el } from "./js/util.js";
import { api, getJson } from "./js/api.js";
import { state, actions } from "./js/state.js";
import { initChat, openSession, sendChat, addError, prefillComposer, pickPhoto, renderSuggestions } from "./js/chat.js";
import { renderToday, renderProgress, renderPlan, loadingView, errorView } from "./js/views.js";
import { startOnboarding } from "./js/onboarding.js";
import { buildOnboardingMessage, initials } from "./js/logic.js";

const ROUTES = ["today", "coach", "progress", "plan"];
const desktop = window.matchMedia("(min-width: 1024px)");

// ------------------------------------------------------------- routing
function currentRoute() {
  const r = location.hash.replace(/^#/, "");
  return ROUTES.includes(r) ? r : "today";
}

function navigate(route) {
  if (currentRoute() === route && location.hash) applyRoute();
  else location.hash = route;
}

function applyRoute() {
  if ($("app-view").hidden) return;
  let route = currentRoute();
  // On desktop the coach is a persistent side panel, so #coach shows Today.
  const view = route === "coach" && desktop.matches ? "today" : route;
  const shell = $("app-view");
  shell.dataset.route = route;
  for (const v of document.querySelectorAll(".view")) v.hidden = v.dataset.view !== view;
  for (const link of document.querySelectorAll(".tab, .rail-link")) {
    const active = link.dataset.route === (desktop.matches ? view : route);
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  if (route === "coach") {
    document.querySelector(".tab[data-route='coach'] .unread").hidden = true;
    const m = $("messages");
    requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
  } else {
    $("main-content").scrollTop = 0;
    renderView(view);
  }
  document.title = `${route === "coach" ? "Coach" : view[0].toUpperCase() + view.slice(1)} · Fitness Buddy`;
}

// ------------------------------------------------------------- dashboard
let dashboardPromise = null;
let refreshTimer = null;

async function loadDashboard(range = state.range) {
  dashboardPromise = getJson(`/api/dashboard?range=${range}`).then((d) => {
    state.dashboard = d;
    state.dashboardError = null;
    if (d.range_days) state.range = d.range_days;
    return d;
  }).catch((err) => {
    state.dashboardError = err.message;
    throw err;
  });
  return dashboardPromise;
}

function renderView(view) {
  const root = $(`view-${view}`);
  if (!root) return;
  const d = state.dashboard;
  if (!d) {
    root.replaceChildren(state.dashboardError ? errorView(state.dashboardError, () => refreshDashboard(true)) : loadingView());
    return;
  }
  if (!d.has_profile) {
    root.replaceChildren(el("section", { class: "card" }, [el("div", { class: "empty" }, [
      el("h3", { text: "Let's set up your profile" }),
      el("p", { class: "muted", text: "Tell your coach your goal, body stats and schedule, and your dashboard will fill in." }),
      el("button", { type: "button", class: "btn btn-primary", onclick: showOnboarding, text: "Set up my profile" }),
    ])]));
    return;
  }
  if (view === "today") renderToday(root, d);
  else if (view === "progress") renderProgress(root, d, changeRange);
  else if (view === "plan") renderPlan(root, d);
}

async function changeRange(range) {
  state.range = range;
  try { await loadDashboard(range); } catch (_) { /* error view below */ }
  applyRoute();
}

async function refreshDashboard(immediate = false) {
  clearTimeout(refreshTimer);
  const run = async () => {
    try { await loadDashboard(); } catch (_) { /* keep the old data */ }
    renderSuggestions(state.dashboard);
    if (!$("app-view").hidden) {
      const route = currentRoute();
      const view = route === "coach" && desktop.matches ? "today" : route;
      if (view !== "coach") renderView(view);
    }
  };
  if (immediate) await run();
  else refreshTimer = setTimeout(run, 300);
}

// ------------------------------------------------------------- coach actions
/** Opens the Coach (tab on mobile, panel on desktop) and optionally sends/prefills. */
function openCoach({ send = null, prefill = null, photo = null, focus = false } = {}) {
  if (!desktop.matches) navigate("coach");
  // Must stay synchronous inside the click handler so the file picker opens.
  if (photo) { pickPhoto(photo); return; }
  if (send) {
    if (state.streaming) prefillComposer(send);
    else sendChat(send);
    return;
  }
  if (prefill) { prefillComposer(prefill); return; }
  if (focus) $("message-input").focus();
}

function markUnread() {
  const onCoach = desktop.matches || currentRoute() === "coach";
  if (!onCoach) document.querySelector(".tab[data-route='coach'] .unread").hidden = false;
}

// ------------------------------------------------------------- onboarding
function showOnboarding() {
  state.onboarding = true;
  $("app-view").hidden = true;
  $("landing-view").hidden = true;
  $("onboarding-view").hidden = false;
  window.scrollTo(0, 0);
  startOnboarding({
    onFinish: async (answers) => {
      leaveOnboarding();
      navigate("coach");
      await sendChat(buildOnboardingMessage(answers));
    },
    onSkip: async () => {
      leaveOnboarding();
      navigate("coach");
      if (state.sessionReady) await state.sessionReady;
      if (state.pendingGreeting) await sendChat(state.config.greeting_text, null, { hidden: true });
    },
  });
}

function leaveOnboarding() {
  state.onboarding = false;
  $("onboarding-view").hidden = true;
  $("onboarding-view").replaceChildren();
  $("app-view").hidden = false;
}

// ------------------------------------------------------------- auth
function showSignIn() {
  $("app-view").hidden = true;
  $("onboarding-view").hidden = true;
  $("landing-view").hidden = false;
  const render = () => {
    if (!state.config.google_client_id) {
      $("signin-error").textContent = "Google sign-in is not configured on this server.";
      return;
    }
    window.google.accounts.id.initialize({ client_id: state.config.google_client_id, callback: onGoogleCredential, ux_mode: "popup" });
    const width = Math.min(400, $("gis-button").clientWidth || 320);
    window.google.accounts.id.renderButton($("gis-button"), { theme: "outline", size: "large", shape: "pill", text: "signin_with", width });
  };
  if (window.google && window.google.accounts) render();
  else {
    const wait = setInterval(() => { if (window.google && window.google.accounts) { clearInterval(wait); render(); } }, 100);
  }
}

async function onGoogleCredential(response) {
  $("signin-error").textContent = "";
  try {
    await api("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });
    await startApp();
  } catch (err) {
    $("signin-error").textContent = err.message;
  }
}

async function signOut() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
  closeMenu();
  showSignIn();
}

function renderAvatar() {
  const me = state.me || {};
  for (const node of document.querySelectorAll(".avatar")) {
    node.replaceChildren(me.picture
      ? el("img", { src: me.picture, alt: "", referrerpolicy: "no-referrer" })
      : el("span", { text: initials(me) }));
  }
  $("menu-email").textContent = me.email || "";
  for (const b of document.querySelectorAll(".sign-out-btn")) b.hidden = Boolean(state.config.dev_auth_bypass);
}

function closeMenu() {
  $("user-menu").hidden = true;
  $("avatar-btn").setAttribute("aria-expanded", "false");
}

async function startApp() {
  $("landing-view").hidden = true;
  try {
    const me = await fetch("/api/me", { credentials: "same-origin" });
    state.me = me.ok ? await me.json() : null;
  } catch (_) { state.me = null; }
  renderAvatar();

  // Open the conversation and load the dashboard in parallel.
  state.sessionReady = openSession().then((session) => {
    state.pendingGreeting = Boolean(session.is_new);
    return session;
  }).catch((err) => { addError(err.message); return null; });
  let dashboard = null;
  try { dashboard = await loadDashboard(); } catch (_) { /* rendered as an error card */ }
  renderSuggestions(dashboard);

  if (dashboard && dashboard.has_profile === false) {
    showOnboarding();
    return;
  }
  $("app-view").hidden = false;
  applyRoute();
  const session = await state.sessionReady;
  // Hidden greeting so the coach runs its check-ins (FR-8).
  if (session && session.is_new && state.pendingGreeting && !state.onboarding) {
    await sendChat(state.config.greeting_text, null, { hidden: true });
  }
}

// ------------------------------------------------------------- boot
async function boot() {
  actions.openCoach = openCoach;
  actions.navigate = navigate;
  actions.refreshDashboard = refreshDashboard;
  actions.showSignIn = showSignIn;
  actions.markUnread = markUnread;
  actions.signOut = signOut;

  state.config = await (await fetch("/api/config")).json();
  initChat();

  window.addEventListener("hashchange", applyRoute);
  desktop.addEventListener("change", applyRoute);
  $("new-chat-btn").addEventListener("click", async () => {
    if (state.streaming) return;
    try {
      state.sessionReady = openSession({ fresh: true }).catch((err) => { addError(err.message); return null; });
      const session = await state.sessionReady;
      if (session && session.is_new) await sendChat(state.config.greeting_text, null, { hidden: true });
    } catch (err) { addError(err.message); }
  });
  for (const b of document.querySelectorAll(".sign-out-btn")) b.addEventListener("click", signOut);
  $("avatar-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("user-menu").hidden;
    $("user-menu").hidden = !open;
    $("avatar-btn").setAttribute("aria-expanded", String(open));
    if (open) $("user-menu").querySelector("button:not([hidden])")?.focus();
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("user-menu").hidden) { closeMenu(); $("avatar-btn").focus(); } });

  const me = await fetch("/api/me", { credentials: "same-origin" });
  if (me.ok) await startApp();
  else showSignIn();
}

document.addEventListener("DOMContentLoaded", () => {
  boot().catch((err) => {
    document.body.append(el("p", { class: "msg-error boot-error", role: "alert", text: `Could not start the app: ${err.message}` }));
  });
});
