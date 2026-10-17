// Fitness Buddy web client: vanilla JS ES modules, no build step.
// Talks to the FastAPI backend in web/main.py (SSE over fetch for chat).
import { $, el, icon } from "./js/util.js";
import { api, getJson } from "./js/api.js";
import { state, actions } from "./js/state.js";
import { initChat, openSession, sendChat, addError, prefillComposer, pickPhoto, renderSuggestions } from "./js/chat.js";
import { renderToday, renderProgress, renderPlan, loadingView, errorView, setupProfileView } from "./js/views.js";
import { startOnboarding, rerenderOnboarding } from "./js/onboarding.js";
import { buildOnboardingMessage, initials } from "./js/logic.js";
import { t, getLang, setLang, detectLang, applyStatic } from "./js/i18n.js";
import { settingsMenu, langSwitch, themeToggle, refreshThemeToggles } from "./js/settings.js";
import { THEME_EVENT } from "./js/theme.js";
import { initLanding, localizeLandingImages } from "./js/landing.js";
import { track, enableTelemetry } from "./js/telemetry.js";
import { openFeedbackDialog } from "./js/feedback.js";
import { exportData, openDeleteDialog } from "./js/account.js";
import { loadAndRenderAdmin } from "./js/admin.js";

const ROUTES = ["today", "coach", "progress", "plan", "admin"];
const desktop = window.matchMedia("(min-width: 1024px)");
const MENUS = [["avatar-btn", "user-menu"], ["rail-avatar-btn", "rail-menu"]];
let lastTab = null;

/** The hidden "opened the app" message in the current language. */
function greetingText() {
  const texts = state.config.greeting_texts || {};
  return texts[getLang()] || state.config.greeting_text;
}

// ------------------------------------------------------------- routing
function currentRoute() {
  const r = location.hash.replace(/^#/, "");
  if (r === "admin" && !(state.me && state.me.is_admin)) return "today";
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
  const tab = desktop.matches ? view : route;
  if (tab !== lastTab) { lastTab = tab; track("tab_view", { tab }); }
  for (const link of document.querySelectorAll(".tab, .rail-link")) {
    const active = link.dataset.route === (desktop.matches ? view : route);
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  if (route === "coach") {
    document.querySelector(".tab[data-route='coach'] .unread").hidden = true;
    $("toast-region").replaceChildren();
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
  if (view === "admin") {
    loadAndRenderAdmin(root, { showToast });
    return;
  }
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

/** Where feedback was sent from: today | coach | progress | plan | onboarding | landing. */
function currentPage() {
  if (state.onboarding) return "onboarding";
  if (!$("landing-view").hidden) return "landing";
  return currentView();
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

/** Spinner pill on the Coach tab while a turn runs (mobile; the desktop panel is always visible). */
function setBusy(on) {
  const tab = document.querySelector(".tab[data-route='coach']");
  tab.classList.toggle("busy", on);
  tab.querySelector(".tab-busy").hidden = !on;
  tab.querySelector(".tab-busy-label").hidden = !on;
  if (on) tab.querySelector(".unread").hidden = true;
}

function showToast(message, { onClick = null, timeout = 8000, iconName = "check-circle" } = {}) {
  const region = $("toast-region");
  region.replaceChildren();
  const close = () => { toast.classList.add("leaving"); setTimeout(() => toast.remove(), 200); };
  const toast = el("div", { class: "toast" }, [
    el("button", { type: "button", class: "toast-main", onclick: () => { close(); if (onClick) onClick(); } }, [
      icon(iconName), el("span", { text: message }), onClick ? el("span", { class: "toast-action", text: t("toast.view") }) : null,
    ]),
    el("button", { type: "button", class: "toast-close", "aria-label": t("toast.dismiss"), onclick: close }, [icon("close")]),
  ]);
  region.append(toast);
  setTimeout(() => { if (toast.isConnected) close(); }, timeout);
}

/** A confirmation arrived: if the user is elsewhere (mobile), offer a shortcut back to it. */
function onConfirmation(card, node) {
  if (desktop.matches || currentRoute() === "coach" || $("app-view").hidden) return;
  showToast(t(card.kind === "replace_training_plan" ? "toast.plan" : "toast.confirm"), {
    onClick: () => {
      navigate("coach");
      // After the hashchange re-render (which scrolls the chat to the bottom).
      setTimeout(() => node.scrollIntoView({ block: "start" }), 80);
    },
  });
}

function markUnread() {
  const onCoach = desktop.matches || currentRoute() === "coach";
  if (!onCoach) document.querySelector(".tab[data-route='coach'] .unread").hidden = false;
}

// ------------------------------------------------------------- language
/** Switches the UI language and re-renders without a reload (chat text stays as-is). */
function setLanguage(lang) {
  setLang(lang);
  track("lang_change", { lang });
  applyStatic();
  renderMenus();
  refreshThemeToggles();
  renderLandingLang();
  renderSuggestions(state.dashboard);
  if (state.onboarding) rerenderOnboarding();
  if (!$("app-view").hidden && currentView() !== "coach") renderView(currentView());
  if (!$("landing-view").hidden) { localizeLandingImages(); renderGisButton(); renderWaitlistNotice(); }
  updateTitle();
}

function renderLandingLang() {
  $("landing-lang").replaceChildren(langSwitch());
}

// ------------------------------------------------------------- menus
function renderMenus() {
  const isAdmin = Boolean(state.me && state.me.is_admin);
  const options = {
    email: (state.me && state.me.email) || "",
    isAdmin,
    onAdmin: () => { closeMenus(); navigate("admin"); },
    showSignOut: !(state.config && state.config.dev_auth_bypass),
    onSignOut: signOut,
    onFeedback: () => { closeMenus(); openFeedbackDialog({ page: currentPage() }); },
    onExport: () => { closeMenus(); runExport(); },
    onDelete: () => { closeMenus(); openDeleteDialog({ onExport: runExport, onDeleted: afterAccountDeleted }); },
  };
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
  track("onboarding_start");
  $("app-view").hidden = true;
  $("landing-view").hidden = true;
  $("onboarding-view").hidden = false;
  window.scrollTo(0, 0);
  startOnboarding({
    onFinish: async (answers) => {
      track("onboarding_complete");
      leaveOnboarding();
      navigate("coach");
      await sendChat(buildOnboardingMessage(answers, getLang()));
    },
    onSkip: async () => {
      track("onboarding_skip");
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
/** Renders the standard white Google button into the hero and final CTA slots. */
function renderGisButton() {
  const slots = ["gis-hero", "gis-cta"].map((id) => $(id)).filter(Boolean);
  if (!state.config.google_client_id) {
    $("signin-error").textContent = t("signin.notConfigured");
    return;
  }
  if (!(window.google && window.google.accounts)) return;
  // Compact real Google button in the top nav (a scripted click on GIS is not possible).
  const nav = $("gis-nav");
  if (nav) {
    for (const child of [...nav.children]) if (child.id !== "lp-signin-btn") child.remove();
    const host = el("div", { class: "gis-host" });
    nav.append(host);
    window.google.accounts.id.renderButton(host, {
      type: "standard", theme: "outline", size: "medium", shape: "pill", text: "signin",
      locale: getLang() === "zh" ? "zh_CN" : "en",
    });
    nav.classList.add("gis-ready");
  }
  for (const slot of slots) {
    for (const child of [...slot.children]) if (!child.classList.contains("gis-placeholder")) child.remove();
    const host = el("div", { class: "gis-host" });
    slot.append(host);
    // Same width as the placeholder pill: full width (max 360) on phones, 280 px otherwise.
    const width = Math.round(Math.max(200, Math.min(360, slot.getBoundingClientRect().width || 280)));
    window.google.accounts.id.renderButton(host, {
      theme: "outline", size: "large", shape: "pill", text: "signin_with", logo_alignment: "left", width,
      locale: getLang() === "zh" ? "zh_CN" : "en",
    });
    slot.classList.add("gis-ready");
  }
}

function showSignIn() {
  enableTelemetry(false);
  lastTab = null;
  $("app-view").hidden = true;
  $("onboarding-view").hidden = true;
  $("landing-view").hidden = false;
  closeMenus();
  renderLandingLang();
  initLanding();
  document.querySelector(".skip-link").setAttribute("href", "#lp-main");
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

let waitlistedEmail = null;

function renderWaitlistNotice() {
  if (!waitlistedEmail) return;
  const node = $("signin-error");
  node.classList.add("signin-waitlist");
  node.replaceChildren(
    el("strong", { class: "waitlist-title", text: t("signin.waitlistTitle") }),
    el("span", { class: "waitlist-body", text: t("signin.waitlistBody", { email: waitlistedEmail }) }),
  );
}

async function onGoogleCredential(response) {
  const node = $("signin-error");
  waitlistedEmail = null;
  node.classList.remove("signin-waitlist");
  node.textContent = "";
  try {
    await api("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential, lang: getLang() }),
    });
    await startApp();
  } catch (err) {
    if (err && err.code === "waitlisted") {
      waitlistedEmail = err.email || "";
      renderWaitlistNotice();
    } else {
      node.textContent = err.message;
    }
  }
}

async function signOut() {
  await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
  closeMenus();
  showSignIn();
}

/** Menu "Export my data": downloads the JSON export. */
async function runExport() {
  try {
    await exportData();
    showToast(t("export.done"), { timeout: 5000 });
  } catch (err) {
    showToast(t("export.error", { message: err.message }), { iconName: "warning" });
  }
}

/** The server deleted the data and cleared the session: back to the landing page. */
function afterAccountDeleted() {
  if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
  state.me = null;
  state.dashboard = null;
  $("messages").replaceChildren();
  showSignIn();
  window.scrollTo(0, 0);
  showToast(t("del.done"));
}

function renderAvatar() {
  const me = state.me || {};
  for (const node of document.querySelectorAll(".avatar")) {
    node.replaceChildren(me.picture
      ? el("img", { src: me.picture, alt: "", referrerpolicy: "no-referrer" })
      : el("span", { text: initials(me) }));
  }
  const railAdmin = $("rail-admin-link");
  if (railAdmin) railAdmin.hidden = !Boolean(me.is_admin);
  renderMenus();
}

async function startApp() {
  $("landing-view").hidden = true;
  document.querySelector(".skip-link").setAttribute("href", "#main-content");
  try {
    const me = await fetch("/api/me", { credentials: "same-origin" });
    state.me = me.ok ? await me.json() : null;
  } catch (_) { state.me = null; }
  enableTelemetry(true);
  track("app_open");
  renderAvatar();

  // Open the conversation and load the dashboard in parallel.
  state.sessionReady = openSession().then((session) => {
    state.pendingGreeting = Boolean(session.is_new);
    return session;
  }).catch((err) => { addError(err.message); return null; });
  let dashboard = null;
  try { dashboard = await loadDashboard(); } catch (_) { /* rendered as an error card */ }
  renderSuggestions(dashboard);

  if (dashboard && dashboard.has_profile === false && currentRoute() !== "admin") {
    showOnboarding();
    return;
  }
  $("app-view").hidden = false;
  applyRoute();
  const session = await state.sessionReady;
  // Hidden greeting so the coach runs its check-ins (FR-8), in the UI language.
  if (session && session.is_new && state.pendingGreeting && !state.onboarding && currentRoute() !== "admin") {
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
  actions.setBusy = setBusy;
  actions.onConfirmation = onConfirmation;

  state.config = await (await fetch("/api/config")).json();
  initChat();
  bindMenus();

  window.addEventListener("hashchange", applyRoute);
  for (const id of ["lp-theme-slot", "topbar-theme-slot", "rail-theme-slot"]) $(id).replaceChildren(themeToggle());
  document.addEventListener(THEME_EVENT, () => {
    renderMenus();
    if (!$("landing-view").hidden) renderGisButton();
  });
  desktop.addEventListener("change", applyRoute);
  $("feedback-fab").addEventListener("click", () => openFeedbackDialog({ page: currentPage() }));
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
