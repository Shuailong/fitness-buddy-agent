// Settings controls shared by the mobile avatar menu, the desktop rail menu,
// the dedicated #settings view, the landing page and onboarding: theme
// (System / Light / Dark), language (EN / 中文), AI coach persona & voice,
// PDPA privacy & usage data controls, and account data management.
import { el, icon } from "./util.js";
import { postJson } from "./api.js";
import { t, getLang, LANGS } from "./i18n.js";
import { THEMES, getTheme, setTheme, effectiveTheme, toggleTheme, THEME_EVENT } from "./theme.js";
import { state, actions } from "./state.js";
import { initials } from "./logic.js";
import { track, enableTelemetry } from "./telemetry.js";
import { coachAvatar, getPersona, getPersonaId, renderPersonaSelectorGrid } from "./personas.js";
import { coachMemoryCard } from "./memory.js";
import { hasUnseenChanges } from "./changelog-data.js";

function segmented(label, options, current, onPick, cls = "") {
  return el("div", { class: `menu-seg ${cls}`.trim(), role: "group", "aria-label": label }, options.map((o) =>
    el("button", {
      type: "button", class: o.value === current ? "active" : "", "aria-pressed": String(o.value === current), "data-value": o.value,
      lang: o.lang || null, onclick: (e) => { e.stopPropagation(); onPick(o.value); },
    }, [o.label])));
}

export function themeSwitch() {
  const node = segmented(t("menu.theme"), THEMES.map((v) => ({ value: v, label: t(`theme.${v}`) })), getTheme(), (value) => {
    setTheme(value);
    track("theme_change", { theme: value });
    for (const b of node.querySelectorAll("button")) {
      const on = b.dataset.value === value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  });
  return node;
}

function paintThemeToggle(btn) {
  const dark = effectiveTheme() === "dark";
  // The icon shows the theme you will switch TO.
  btn.replaceChildren(icon(dark ? "light-mode" : "dark-mode"));
  btn.setAttribute("aria-pressed", String(dark));
  btn.setAttribute("aria-label", t("theme.darkToggle"));
  btn.title = t(dark ? "theme.toLight" : "theme.toDark");
}

/** Round one-click dark/light toggle; all instances stay in sync via THEME_EVENT. */
export function themeToggle(extraClass = "") {
  const btn = el("button", { type: "button", class: `icon-btn theme-toggle ${extraClass}`.trim() });
  btn.addEventListener("click", (e) => { e.stopPropagation(); track("theme_change", { theme: toggleTheme() }); });
  paintThemeToggle(btn);
  return btn;
}

/** Re-labels every toggle (after a theme or language change). */
export function refreshThemeToggles() {
  for (const btn of document.querySelectorAll(".theme-toggle")) paintThemeToggle(btn);
}
document.addEventListener(THEME_EVENT, refreshThemeToggles);

/** EN / 中文 switch; switching re-renders the app through actions.setLanguage. */
export function langSwitch() {
  return segmented(t("menu.language"), LANGS.map((v) => ({ value: v, label: t(`lang.${v}`), lang: v === "zh" ? "zh-CN" : "en" })), getLang(),
    (value) => actions.setLanguage(value), "lang-seg");
}

/** Content of the quick account/settings dropdown menu. */
export function settingsMenu({
  email = "",
  isAdmin = false,
  onAdmin = null,
  onSettings = null,
  onNewChat = null,
  showSignOut = true,
  onSignOut,
  onFeedback = null,
  onPrivacy = null,
  shareUsageData = true,
  onExport = null,
  onDelete = null,
} = {}) {
  const item = (iconName, label, onclick, cls = "") => el("button", { type: "button", class: `menu-item ${cls}`.trim(), onclick }, [icon(iconName), el("span", { text: label })]);
  const isZh = getLang() === "zh";
  const currentPersona = getPersona(getPersonaId(), getLang());
  return [
    email ? el("p", { class: "menu-email", text: email }) : null,
    el("div", { class: "menu-group menu-group-top" }, [
      onSettings ? item("tune", t("settings.allSettingsCoachStudio"), onSettings, "settings-primary-item") : null,
      onNewChat ? item("edit-square", t("settings.startANewChat"), onNewChat) : null,
      el("a", { class: "menu-item", href: "/changelog" }, [
        icon("auto-awesome"),
        el("span", { text: t("menu.changelog") }),
        hasUnseenChanges() ? el("span", { class: "news-dot", "aria-label": t("menu.changelogNew") }) : null,
      ]),
      isAdmin && onAdmin ? item("shield", t("menu.admin"), onAdmin, "admin-item") : null,
    ].filter(Boolean)),
    el("p", { class: "menu-label", text: t("menu.theme") }),
    themeSwitch(),
    el("p", { class: "menu-label", text: t("menu.language") }),
    langSwitch(),
    el("div", { class: "menu-group" }, [
      onSettings
        ? el("button", { type: "button", class: "menu-item", onclick: onSettings }, [
            coachAvatar(currentPersona.id, { size: "sm" }),
            el("span", { text: t("settings.coachP0", { p0: currentPersona.copy.shortName }) }),
          ])
        : null,
      onPrivacy
        ? el("button", { type: "button", class: "menu-item menu-privacy-btn", onclick: onPrivacy }, [
            icon("shield"),
            el("span", { text: t("settings.privacyDataControls") }),
            el("span", {
              class: `menu-pdpa-dot ${shareUsageData ? "is-on" : "is-off"}`,
              title: shareUsageData
                ? (t("settings.usageSharingOn"))
                : (t("settings.optedOutOfUsageSharing")),
              text: shareUsageData ? (t("settings.shared")) : (t("settings.private")),
            }),
          ])
        : null,
      onFeedback ? item("rate-review", t("fb.menu"), onFeedback) : null,
      onExport ? item("download", t("menu.export"), onExport) : null,
    ].filter(Boolean)),
    el("div", { class: "menu-group" }, [
      onDelete ? item("delete-forever", t("menu.delete"), onDelete, "danger") : null,
      showSignOut ? item("logout", t(state.me && state.me.is_demo ? "demo.leave" : "menu.signOut"), onSignOut) : null,
    ].filter(Boolean)),
  ];
}

/**
 * Full dedicated #settings view consolidating:
 * 1. AI Coach Persona Selection & Voice Preview
 * 2. Appearance, Language & Product Feedback
 * 3. PDPA Privacy & Usage Data Controls
 * 4. Account & Data Management
 */
export function renderSettingsView(root, {
  onExport = null,
  onDelete = null,
  onSignOut = null,
  showSignOut = true,
  onAdmin = null,
  onFeedback = null,
  onPrivacyUpdated = null,
  showToast = null,
  onDiagnostics = null,
} = {}) {
  const isZh = getLang() === "zh";
  const me = state.me || {};
  const isAdmin = Boolean(me.is_admin);
  const currentPrivacyPref = () => !(state.me && state.me.privacy && state.me.privacy.share_usage_data === false);

  // PDPA inline toggle state
  const pdpaStatusBadge = el("span", { class: "pdpa-status-pill" });
  const pdpaToggleInput = el("input", {
    type: "checkbox",
    class: "pdpa-switch-input",
    id: "settings-pdpa-share-toggle",
    checked: currentPrivacyPref() ? "checked" : null,
  });
  const pdpaNote = el("p", { class: "pdpa-feedback-note", hidden: true });

  function syncPdpaUi(enabled) {
    pdpaToggleInput.checked = Boolean(enabled);
    pdpaStatusBadge.className = `pdpa-status-pill ${enabled ? "is-on" : "is-off"}`;
    pdpaStatusBadge.textContent = enabled
      ? (t("account.sharingEnabled"))
      : (t("settings.optedOutPrivateMode"));
  }
  syncPdpaUi(currentPrivacyPref());

  pdpaToggleInput.addEventListener("change", async () => {
    const nextVal = Boolean(pdpaToggleInput.checked);
    pdpaToggleInput.disabled = true;
    pdpaNote.hidden = true;
    try {
      const res = await postJson("/api/account/privacy", { share_usage_data: nextVal });
      const pref = (res && res.privacy) || { share_usage_data: nextVal };
      if (!state.me) state.me = {};
      state.me.privacy = pref;
      enableTelemetry(Boolean(pref.share_usage_data));
      syncPdpaUi(Boolean(pref.share_usage_data));
      pdpaNote.className = "pdpa-feedback-note is-ok";
      pdpaNote.textContent = pref.share_usage_data
        ? (t("account.preferenceSavedAnonymousOperationalUsage"))
        : (t("account.consentWithdrawnUsageTelemetryIs"));
      pdpaNote.hidden = false;
      if (onPrivacyUpdated) onPrivacyUpdated(pref);
      if (showToast) {
        showToast(
          pref.share_usage_data
            ? (t("account.usageDataSharingEnabled"))
            : (t("account.usageDataSharingDisabledRecords")),
          { timeout: 4500 }
        );
      }
    } catch (err) {
      pdpaToggleInput.checked = !nextVal;
      syncPdpaUi(!nextVal);
      pdpaNote.className = "pdpa-feedback-note is-err";
      pdpaNote.textContent = t("account.couldNotUpdatePreferenceP0", { p0: err.message });
      pdpaNote.hidden = false;
    } finally {
      pdpaToggleInput.disabled = false;
    }
  });

  const row = (iconName, label, { href = null, onclick = null, danger = false, trailing = null, external = false } = {}) => {
    const children = [
      el("span", { class: "settings-row-icon", "aria-hidden": "true" }, [icon(iconName)]),
      el("span", { class: "settings-row-label", text: label }),
      trailing,
      icon(external ? "open-in-new" : "chevron-right", { cls: "settings-row-chev" }),
    ];
    const cls = `settings-row${danger ? " is-danger" : ""}`;
    return href
      ? el("a", { class: cls, href, ...(external ? { target: "_blank", rel: "noopener" } : {}) }, children)
      : el("button", { type: "button", class: cls, onclick }, children);
  };
  const rerender = () => renderSettingsView(root, {
    onExport, onDelete, onSignOut, showSignOut, onAdmin, onFeedback, onPrivacyUpdated, showToast, onDiagnostics,
  });

  root.replaceChildren(
    el("header", { class: "page-head settings-head" }, [el("h1", { text: t("settings.settings") })]),

    el("div", { class: "settings-stack" }, [
      // Account summary (the avatar in the header opens this page).
      el("section", { class: "card settings-profile" }, [
        el("span", { class: "avatar settings-user-avatar" }, [
          me.picture
            ? el("img", { src: me.picture, alt: "", referrerpolicy: "no-referrer" })
            : el("span", { text: initials(me) }),
        ]),
        el("div", { class: "settings-user-meta" }, [
          el("div", { class: "settings-user-name-row" }, [
            el("strong", { text: me.name || me.given_name || (t("settings.signedInUser")) }),
            el("span", {
              class: `pill ${isAdmin ? "pill-primary" : "pill-outline"}`,
              text: me.is_demo ? t("demo.bannerTitle") : isAdmin ? (t("settings.admin")) : (t("settings.betaMember")),
            }),
          ]),
          el("span", { class: "muted small", text: me.is_demo ? t("demo.badge") : me.email || "" }),
        ]),
      ]),

      // 1. AI Coach Persona & Voice Studio
      el("section", { class: "card settings-card", "aria-labelledby": "settings-coach-heading" }, [
        el("div", { class: "settings-card-head" }, [
          el("div", { class: "settings-card-title-group" }, [
            el("span", { class: "round-icon", "aria-hidden": "true" }, [icon("smart-toy")]),
            el("div", {}, [
              el("h2", { id: "settings-coach-heading", text: t("settings.aiCoachPersonaVoice") }),
              el("p", {
                class: "muted small",
                text: t("settings.pickTheCoachingStyleThat"),
              }),
            ]),
          ]),
        ]),
        renderPersonaSelectorGrid({
          onSwitched: rerender,
        }),
      ]),

      // Everyday preferences: theme and language.
      el("section", { class: "card settings-card", "aria-labelledby": "settings-pref-heading" }, [
        el("h2", { id: "settings-pref-heading", class: "settings-section-title", text: t("settings.appearanceLanguage") }),
        el("div", { class: "settings-pref-grid" }, [
          el("div", { class: "settings-pref-item" }, [
            el("div", { class: "settings-pref-copy" }, [el("strong", { text: t("menu.theme") })]),
            themeSwitch(),
          ]),
          el("div", { class: "settings-pref-item" }, [
            el("div", { class: "settings-pref-copy" }, [el("strong", { text: t("menu.language") })]),
            langSwitch(),
          ]),
        ]),
      ]),

      // Coach Memory (cross-session preferences, shared by all coaches)
      coachMemoryCard({ showToast }),

      // Less frequent: one compact list.
      el("section", { class: "card settings-card settings-list-card", "aria-labelledby": "settings-more-heading" }, [
        el("h2", { id: "settings-more-heading", class: "settings-section-title", text: t("settings.more") }),
        el("div", { class: "settings-list" }, [
          row("auto-awesome", t("menu.changelog"), {
            href: "/changelog",
            trailing: hasUnseenChanges() ? el("span", { class: "news-dot", "aria-label": t("menu.changelogNew") }) : null,
          }),
          row("install-mobile", t("settings.installOnYourPhone"), { href: "/install" }),
          onFeedback ? row("rate-review", t("fb.menu"), { onclick: onFeedback }) : null,
          el("details", { class: "settings-details" }, [
            el("summary", { class: "settings-row" }, [
              el("span", { class: "settings-row-icon", "aria-hidden": "true" }, [icon("shield")]),
              el("span", { class: "settings-row-label", text: t("settings.privacyDataSharing") }),
              pdpaStatusBadge,
              icon("expand-more", { cls: "settings-row-chev" }),
            ]),
            el("div", { class: "settings-details-body" }, [
        el("div", { class: "pdpa-boundary-grid settings-pdpa-grid" }, [
          el("div", { class: "pdpa-boundary-col is-private" }, [
            el("div", { class: "pdpa-boundary-head" }, [
              icon("check-circle"),
              el("strong", { text: t("settings.strictlyPrivateNeverVisibleTo") }),
            ]),
            el("ul", { class: "pdpa-boundary-list" }, [
              el("li", { text: t("settings.allAiCoachTextVoice") }),
              el("li", { text: t("settings.mealPhotosNutritionLogsBody") }),
              el("li", { text: t("settings.liveCameraFormCheckVideo") }),
            ]),
          ]),
          el("div", { class: "pdpa-boundary-col is-ops" }, [
            el("div", { class: "pdpa-boundary-head" }, [
              icon("privacy-tip"),
              el("strong", { text: t("settings.optionalDiagnosticsControlledBelow") }),
            ]),
            el("ul", { class: "pdpa-boundary-list" }, [
              el("li", { text: t("settings.screenViewsFeatureClickCounts") }),
              el("li", { text: t("settings.aiResponseLatencyActiveBeta") }),
            ]),
          ]),
        ]),

        el("div", { class: "pdpa-toggle-card settings-pdpa-toggle" }, [
          el("div", { class: "pdpa-toggle-row" }, [
            el("div", { class: "pdpa-toggle-copy" }, [
              el("label", {
                class: "pdpa-toggle-label",
                for: "settings-pdpa-share-toggle",
                text: t("settings.shareAnonymousUsageOperationalDiagnostics"),
              }),
              el("p", {
                class: "pdpa-toggle-desc",
                text: t("settings.turnThisOffAnytimeUnder"),
              }),
            ]),
            el("label", { class: "pdpa-switch", for: "settings-pdpa-share-toggle", "aria-label": t("account.toggleUsageDataSharing") }, [
              pdpaToggleInput,
              el("span", { class: "pdpa-switch-slider" }),
            ]),
          ]),
          pdpaNote,
        ]),
            ]),
          ]),
          onExport ? row("download", t("menu.export"), { onclick: onExport }) : null,
          row("privacy-tip", t("menu.privacy"), { href: "/privacy", external: true }),
          isAdmin && onAdmin ? row("shield", t("menu.admin"), { onclick: onAdmin }) : null,
          onDiagnostics ? row("monitoring", t("settings.screenDiagnostics"), { onclick: onDiagnostics }) : null,
        ].filter(Boolean)),
      ]),

      // Account actions.
      el("section", { class: "card settings-card settings-list-card" }, [
        el("div", { class: "settings-list" }, [
          showSignOut && onSignOut ? row("logout", t(me.is_demo ? "demo.leave" : "menu.signOut"), { onclick: onSignOut }) : null,
          onDelete ? row("delete-forever", t("menu.delete"), { onclick: onDelete, danger: true }) : null,
        ].filter(Boolean)),
      ]),
    ]),
  );
}

