// Fitness Buddy web client: vanilla JS ES modules, no build step.
// Talks to the FastAPI backend in web/main.py (SSE over fetch for chat).
import { $, el, icon } from "./js/util.js";
import { api, getJson } from "./js/api.js";
import { state, actions } from "./js/state.js";
import { initChat, openSession, sendChat, addError, prefillComposer, pickPhoto, renderSuggestions, syncCoachPersonaHeader } from "./js/chat.js";
import { renderToday, renderProgress, renderPlan, loadingView, errorView, setupProfileView } from "./js/views.js";
import { startOnboarding, rerenderOnboarding } from "./js/onboarding.js";
import { buildOnboardingMessage, initials } from "./js/logic.js";
import { t, getLang, setLang, detectLang, applyStatic } from "./js/i18n.js";
import { settingsMenu, renderSettingsView, langSwitch, themeToggle, refreshThemeToggles } from "./js/settings.js";
import { THEME_EVENT } from "./js/theme.js";
import { initLanding, localizeLandingImages } from "./js/landing.js";
import { track, enableTelemetry } from "./js/telemetry.js";
import { openFeedbackDialog } from "./js/feedback.js";
import { exportData, openDeleteDialog, openPrivacySettingsModal } from "./js/account.js";
import { onPersonaChange, applyServerPersona, getPersonaId } from "./js/personas.js";

const ROUTES = ["today", "coach", "progress", "plan", "settings", "admin"];
const desktop = window.matchMedia("(min-width: 1024px)");
const MENUS = [["avatar-btn", "user-menu"], ["rail-avatar-btn", "rail-menu"]];
const BOOT_CACHE_KEY = "fb.boot_cache_v1";
const BOOT_CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
let lastTab = null;

function hideBootSplash() {
  const splash = $("app-boot-splash");
  if (!splash || splash.hidden || splash.classList.contains("is-leaving")) return;
  splash.classList.add("is-leaving");
  setTimeout(() => {
    splash.hidden = true;
    splash.remove();
  }, 240);
}

function readBootCache() {
  try {
    const raw = window.localStorage.getItem(BOOT_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.me || !parsed.ts) return null;
    if (Date.now() - Number(parsed.ts) > BOOT_CACHE_MAX_AGE_MS) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function writeBootCache() {
  try {
    if (!state.me || !state.me.email) return;
    window.localStorage.setItem(BOOT_CACHE_KEY, JSON.stringify({
      ts: Date.now(),
      config: state.config || {},
      me: state.me,
      dashboard: state.dashboard || null,
    }));
  } catch (_) { /* quota or private mode */ }
}

function clearBootCache() {
  try { window.localStorage.removeItem(BOOT_CACHE_KEY); } catch (_) {}
}

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

async function loadDashboard(range = state.range, prefetchedPromise = null) {
  try {
    const d = prefetchedPromise
      ? (await prefetchedPromise) || await getJson(`/api/dashboard?range=${range}`)
      : await getJson(`/api/dashboard?range=${range}`);
    state.dashboard = d;
    state.dashboardError = null;
    if (d.range_days) state.range = d.range_days;
    writeBootCache();
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
    if (!root.hasChildNodes()) root.replaceChildren(loadingView());
    import("./js/admin.js")
      .then(({ loadAndRenderAdmin }) => loadAndRenderAdmin(root, { showToast }))
      .catch((err) => root.replaceChildren(errorView(err.message, () => renderView("admin"))));
    return;
  }
  if (view === "settings") {
    renderSettingsView(root, {
      onExport: runExport,
      onDelete: () => openDeleteDialog({ onExport: runExport, onDeleted: afterAccountDeleted }),
      onSignOut: signOut,
      showSignOut: !(state.config && state.config.dev_auth_bypass),
      onAdmin: () => navigate("admin"),
      onFeedback: () => openFeedbackDialog({ page: "settings" }),
      onPrivacyUpdated: () => {
        writeBootCache();
        renderMenus();
      },
      showToast,
    });
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
  syncCoachPersonaHeader();
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

function openPrivacy() {
  closeMenus();
  openPrivacySettingsModal({
    onExport: runExport,
    onDelete: () => openDeleteDialog({ onExport: runExport, onDeleted: afterAccountDeleted }),
    onUpdated: () => {
      writeBootCache();
      renderMenus();
    },
    showToast,
  });
}

// ------------------------------------------------------------- menus
function renderMenus() {
  const isAdmin = Boolean(state.me && state.me.is_admin);
  const shareUsageData = !(state.me && state.me.privacy && state.me.privacy.share_usage_data === false);
  const options = {
    email: (state.me && state.me.email) || "",
    isAdmin,
    onAdmin: () => { closeMenus(); navigate("admin"); },
    onSettings: () => { closeMenus(); navigate("settings"); },
    showSignOut: !(state.config && state.config.dev_auth_bypass),
    onSignOut: signOut,
    onFeedback: () => { closeMenus(); openFeedbackDialog({ page: currentPage() }); },
    onPrivacy: openPrivacy,
    shareUsageData,
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
  hideBootSplash();
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
  hideBootSplash();
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
  hideBootSplash();
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
  clearBootCache();
  state.me = null;
  state.dashboard = null;
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
  clearBootCache();
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

/**
 * The coach persona lives on the account (/api/me.preferences) so every device
 * shows the same coach. A device that chose a coach before this existed
 * uploads its local choice once.
 */
function syncPersonaFromAccount(me) {
  if (!me) return;
  const saved = me.preferences && me.preferences.coach_persona;
  if (saved) {
    applyServerPersona(saved);
  } else {
    fetch("/api/account/preferences", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coach_persona: getPersonaId() }),
    }).catch(() => {});
  }
}

/** When the app returns to the foreground, pick up a coach changed on another device. */
async function refreshAccountPrefs() {
  if (document.visibilityState !== "visible" || !state.me || $("app-view").hidden) return;
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (!res.ok) return;
    const me = await res.json();
    state.me = { ...state.me, ...me };
    const saved = me.preferences && me.preferences.coach_persona;
    if (saved) applyServerPersona(saved);
    writeBootCache();
  } catch (_) { /* offline */ }
}

async function startApp(meData = null, prefetchedDashboardPromise = null) {
  $("landing-view").hidden = true;
  document.querySelector(".skip-link").setAttribute("href", "#main-content");
  if (meData) {
    state.me = meData;
  } else {
    try {
      const me = await fetch("/api/me", { credentials: "same-origin" });
      state.me = me.ok ? await me.json() : null;
    } catch (_) { state.me = null; }
  }
  const shareUsageData = !(state.me && state.me.privacy && state.me.privacy.share_usage_data === false);
  enableTelemetry(shareUsageData);
  syncPersonaFromAccount(state.me);
  track("app_open");
  renderAvatar();
  writeBootCache();

  // Unhide the app shell immediately so the user sees either cached data or
  // the animated Today dashboard shimmer skeleton right away.
  if (!state.dashboard || state.dashboard.has_profile !== false || currentRoute() === "admin") {
    $("app-view").hidden = false;
    applyRoute();
    hideBootSplash();
  }

  // Open the conversation and load the dashboard in parallel.
  state.sessionReady = openSession().then((session) => {
    state.pendingGreeting = Boolean(session.is_new);
    return session;
  }).catch((err) => { addError(err.message); return null; });
  let dashboard = null;
  try {
    dashboard = await loadDashboard(state.range, prefetchedDashboardPromise);
  } catch (_) { /* rendered as an error card if no cached dashboard */ }
  renderSuggestions(dashboard || state.dashboard);

  if (dashboard && dashboard.has_profile === false && currentRoute() !== "admin") {
    showOnboarding();
    return;
  }
  $("app-view").hidden = false;
  applyRoute();
  hideBootSplash();
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
  actions.openPrivacy = openPrivacy;
  actions.navigate = navigate;
  actions.refreshDashboard = refreshDashboard;
  actions.showSignIn = showSignIn;
  actions.markUnread = markUnread;
  actions.signOut = signOut;
  actions.setLanguage = setLanguage;
  actions.setBusy = setBusy;
  actions.onConfirmation = onConfirmation;

  initChat();
  bindMenus();

  window.addEventListener("hashchange", applyRoute);
  for (const id of ["lp-theme-slot", "topbar-theme-slot", "rail-theme-slot"]) $(id).replaceChildren(themeToggle());
  document.addEventListener(THEME_EVENT, () => {
    renderMenus();
    if (!$("landing-view").hidden) renderGisButton();
  });
  onPersonaChange((id) => {
    if (state.me) {
      state.me.preferences = { ...(state.me.preferences || {}), coach_persona: id };
      writeBootCache();
    }
    renderMenus();
    if (!$("app-view").hidden && (currentView() === "today" || currentView() === "settings")) {
      renderView(currentView());
    }
  });
  document.addEventListener("visibilitychange", refreshAccountPrefs);
  desktop.addEventListener("change", applyRoute);
  $("feedback-fab").addEventListener("click", () => openFeedbackDialog({ page: currentPage() }));
  $("new-chat-btn").addEventListener("click", async () => {
    if (state.streaming) return;
    state.sessionReady = openSession({ fresh: true }).catch((err) => { addError(err.message); return null; });
    const session = await state.sessionReady;
    if (session && session.is_new) await sendChat(greetingText(), null, { hidden: true });
  });

  // Optimistic instant render from localStorage cache for returning mobile users.
  const cached = readBootCache();
  if (cached && cached.me) {
    state.config = cached.config || state.config;
    state.me = cached.me;
    if (cached.me.preferences && cached.me.preferences.coach_persona) {
      applyServerPersona(cached.me.preferences.coach_persona);
    }
    if (cached.dashboard && cached.dashboard.has_profile) {
      state.dashboard = cached.dashboard;
      $("landing-view").hidden = true;
      $("app-view").hidden = false;
      renderAvatar();
      renderSuggestions(state.dashboard);
      applyRoute();
      hideBootSplash();
    }
  }

  // Consume parallel prefetch started in <head> (theme-boot.js) or fetch in parallel.
  const pre = window.__fbBootPrefetch || {};
  delete window.__fbBootPrefetch;
  const [cfg, meData] = await Promise.all([
    pre.config || fetch("/api/config").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    pre.me !== undefined
      ? pre.me
      : fetch("/api/me", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (cfg) state.config = cfg;

  if (meData) {
    if (cached && cached.me && cached.me.email !== meData.email) {
      state.dashboard = null;
    }
    await startApp(meData, pre.dashboard || null);
  } else {
    clearBootCache();
    state.me = null;
    state.dashboard = null;
    showSignIn();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  boot().catch((err) => {
    hideBootSplash();
    document.body.append(el("p", { class: "msg-error boot-error", role: "alert", text: t("error.boot", { message: err.message }) }));
  });
});
