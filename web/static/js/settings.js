// Settings controls shared by the mobile avatar menu, the desktop rail menu,
// the landing page and onboarding: theme (System / Light / Dark) and
// language (EN / 中文).
import { el, icon } from "./util.js";
import { t, getLang, LANGS } from "./i18n.js";
import { THEMES, getTheme, setTheme, effectiveTheme, toggleTheme, THEME_EVENT } from "./theme.js";
import { actions } from "./state.js";
import { track } from "./telemetry.js";
import { getPersona, getPersonaId, openPersonaSelectorModal } from "./personas.js";

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

/** Content of the account/settings menu. */
export function settingsMenu({ email = "", isAdmin = false, onAdmin = null, showSignOut = true, onSignOut, onFeedback = null, onExport = null, onDelete = null } = {}) {
  const item = (iconName, label, onclick, cls = "") => el("button", { type: "button", class: `menu-item ${cls}`.trim(), onclick }, [icon(iconName), el("span", { text: label })]);
  const isZh = getLang() === "zh";
  const currentPersona = getPersona(getPersonaId(), getLang());
  return [
    email ? el("p", { class: "menu-email", text: email }) : null,
    isAdmin && onAdmin ? el("div", { class: "menu-group menu-group-top" }, [
      item("shield", t("menu.admin"), onAdmin, "admin-item"),
    ]) : null,
    el("div", { class: "menu-group" }, [
      item("smart-toy", isZh ? `教练人设：${currentPersona.copy.shortName}` : `Coach: ${currentPersona.copy.shortName}`, () => openPersonaSelectorModal()),
    ]),
    el("p", { class: "menu-label", text: t("menu.theme") }),
    themeSwitch(),
    el("p", { class: "menu-label", text: t("menu.language") }),
    langSwitch(),
    el("div", { class: "menu-group" }, [
      onFeedback ? item("rate-review", t("fb.menu"), onFeedback) : null,
      el("a", { class: "menu-item", href: "/privacy", target: "_blank", rel: "noopener" }, [
        icon("privacy-tip"), el("span", { text: t("menu.privacy") }), icon("open-in-new", { cls: "menu-ext" }),
      ]),
      onExport ? item("download", t("menu.export"), onExport) : null,
    ]),
    el("div", { class: "menu-group" }, [
      onDelete ? item("delete-forever", t("menu.delete"), onDelete, "danger") : null,
      showSignOut ? item("logout", t("menu.signOut"), onSignOut) : null,
    ]),
  ];
}
