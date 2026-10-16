// Fitness Buddy web client: vanilla JS ES modules, no build step.
// Talks to the FastAPI backend in web/main.py (SSE over fetch for chat).
import { $, el } from "./js/util.js";
import { api, getJson } from "./js/api.js";
import { state, actions } from "./js/state.js";
import { initChat, openSession, sendChat, addError, prefillComposer, pickPhoto, renderSuggestions } from "./js/chat.js";
import { renderToday, renderProgress, renderPlan, loadingView, errorView, setupProfileView } from "./js/views.js";
import { startOnboarding, rerenderOnboarding } from "./js/onboarding.js";
import { buildOnboardingMessage, initials } from "./js/logic.js";
import { t, getLang, setLang, detectLang, applyStatic } from "./js/i18n.js";
import { settingsMenu, langSwitch } from "./js/settings.js";

const ROUTES = ["today", "coach", "progress", "plan"];
const desktop = window.matchMedia("(min-width: 1024px)");
const MENUS = [["avatar-btn", "user-menu"], ["rail-avatar-btn", "rail-menu"]];

/** The hidden "opened the app" message in the current language. */
function greetingText() {
  const texts = state.config.greeting_texts || {};
  return texts[getLang()] || state.config.greeting_text;
}

// ------------------------------------------------------------- routing
function currentRoute() {
  const r = location.hash.replace(/^#/, "");
  return ROUTES.includes(r) ? r : "today";
}

function navigate(route) {
  if (currentRoute() === route && location.hash) applyRoute();
  else location.hash = route;
}

function updateTitle() {
  const route = currentRoute();
  const view = route === "coach" && desktop.matches ? "today" : route;
  const page = $("app-view").hidden ? "" : `${t(`nav.${route === "coach" ? "coach" : view}`)} · `;
  document.title = `${page}${t("app.name")}`;
}

function applyRoute() {
  if ($("app-view").hidden) return;
  const route = currentRoute();
  // On desktop the coach is a persistent side panel, so #coach shows Today.
  const view = route === "coach" && desktop.matches ? "today" : route;
  $("app-view").dataset.route = route;
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
  updateTitle();
}

// ------------------------------------------------------------- dashboard
let refreshTimer = null;

async function loadDashboard(range = state.range) {
  try {
    const d = await getJson(`/api/dashboard?range=${range}`);
    state.dashboard = d;
    state.dashboardError = null;
    if (d.range_days) state.range = d.range_days;
    return d;
  } catch (err) {
    state.dashboardError = err.message;
    throw err;
  }
}

function renderView(view) {
  const root = $(`view-${view}`);
  if (!root) return;
  const d = state.dashboard;
  if (!d) {
    root.replaceChildren(state.dashboardError ? errorView(state.dashboardError, () => refreshDashboard(true)) : loadingView());
    return;
  }
  if (!d.has_profile) { root.replaceChildren(setupProfileView(showOnboarding)); return; }
  if (view === "today") renderToday(root, d);
  else if (view === "progress") renderProgress(root, d, changeRange);
  else if (view === "plan") renderPlan(root, d);
}

function currentView() {
  const route = currentRoute();
  return route === "coach" && desktop.matches ? "today" : route;
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
    if (!$("app-view").hidden && currentView() !== "coach") renderView(currentView());
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

// ------------------------------------------------------------- language
/** Switches the UI language and re-renders without a reload (chat text stays as-is). */
function setLanguage(lang) {
  setLang(lang);
  applyStatic();
  renderMenus();
  renderLandingLang();
  renderSuggestions(state.dashboard);
  if (state.onboarding) rerenderOnboarding();
  if (!$("app-view").hidden && currentView() !== "coach") renderView(currentView());
  if (!$("landing-view").hidden) renderGisButton();
  updateTitle();
}

function renderLandingLang() {
  $("landing-lang").replaceChildren(langSwitch());
}

// ------------------------------------------------------------- menus
function renderMenus() {
  const options = { email: (state.me && state.me.email) || "", showSignOut: !(state.config && state.config.dev_auth_bypass), onSignOut: signOut };
  for (const [, menuId] of MENUS) $(menuId).replaceChildren(...settingsMenu(options).filter(Boolean));
}

function closeMenus() {
  for (const [btnId, menuId] of MENUS) {
    $(menuId).hidden = true;
    $(btnId).setAttribute("aria-expanded", "false");
  }
}

function bindMenus() {
  for (const [btnId, menuId] of MENUS) {
    $(btnId).addEventListener("click", (e) => {
      e.stopPropagation();
      const open = $(menuId).hidden;
      closeMenus();
      $(menuId).hidden = !open;
      $(btnId).setAttribute("aria-expanded", String(open));
      if (open) $(menuId).querySelector("button")?.focus();
    });
  }
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu-wrap")) closeMenus(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const [btnId, menuId] of MENUS) {
      if (!$(menuId).hidden) { closeMenus(); $(btnId).focus(); }
    }
  });
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
      await sendChat(buildOnboardingMessage(answers, getLang()));
    },
    onSkip: async () => {
      leaveOnboarding();
      navigate("coach");
      if (state.sessionReady) await state.sessionReady;
      if (state.pendingGreeting) await sendChat(greetingText(), null, { hidden: true });
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
function renderGisButton() {
  if (!state.config.google_client_id) {
    $("signin-error").textContent = t("signin.notConfigured");
    return;
  }
  if (!(window.google && window.google.accounts)) return;
  const width = Math.min(400, $("gis-button").clientWidth || 320);
  $("gis-button").replaceChildren();
  window.google.accounts.id.renderButton($("gis-button"), {
    theme: "outline", size: "large", shape: "pill", text: "signin_with", width, locale: getLang() === "zh" ? "zh_CN" : "en",
  });
}

function showSignIn() {
  $("app-view").hidden = true;
  $("onboarding-view").hidden = true;
  $("landing-view").hidden = false;
  closeMenus();
  renderLandingLang();
  updateTitle();
  const render = () => {
    if (state.config.google_client_id) {
      window.google.accounts.id.initialize({ client_id: state.config.google_client_id, callback: onGoogleCredential, ux_mode: "popup" });
    }
    renderGisButton();
  };
  if (!state.config.google_client_id || (window.google && window.google.accounts)) render();
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
  closeMenus();
  showSignIn();
}

function renderAvatar() {
  const me = state.me || {};
  for (const node of document.querySelectorAll(".avatar")) {
    node.replaceChildren(me.picture
      ? el("img", { src: me.picture, alt: "", referrerpolicy: "no-referrer" })
      : el("span", { text: initials(me) }));
  }
  renderMenus();
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
  // Hidden greeting so the coach runs its check-ins (FR-8), in the UI language.
  if (session && session.is_new && state.pendingGreeting && !state.onboarding) {
    await sendChat(greetingText(), null, { hidden: true });
  }
}

// ------------------------------------------------------------- boot
async function boot() {
  setLang(detectLang(), { persist: false });
  applyStatic();
  actions.openCoach = openCoach;
  actions.navigate = navigate;
  actions.refreshDashboard = refreshDashboard;
  actions.showSignIn = showSignIn;
  actions.markUnread = markUnread;
  actions.signOut = signOut;
  actions.setLanguage = setLanguage;

  state.config = await (await fetch("/api/config")).json();
  initChat();
  bindMenus();

  window.addEventListener("hashchange", applyRoute);
  desktop.addEventListener("change", applyRoute);
  $("new-chat-btn").addEventListener("click", async () => {
    if (state.streaming) return;
    state.sessionReady = openSession({ fresh: true }).catch((err) => { addError(err.message); return null; });
    const session = await state.sessionReady;
    if (session && session.is_new) await sendChat(greetingText(), null, { hidden: true });
  });

  const me = await fetch("/api/me", { credentials: "same-origin" });
  if (me.ok) await startApp();
  else showSignIn();
}

document.addEventListener("DOMContentLoaded", () => {
  boot().catch((err) => {
    document.body.append(el("p", { class: "msg-error boot-error", role: "alert", text: t("error.boot", { message: err.message }) }));
  });
});
