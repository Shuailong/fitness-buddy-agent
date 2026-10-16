// Settings controls shared by the mobile avatar menu, the desktop rail menu,
// the landing page and onboarding: theme (System / Light / Dark) and
// language (EN / 中文).
import { el, icon } from "./util.js";
import { t, getLang, LANGS } from "./i18n.js";
import { THEMES, getTheme, setTheme } from "./theme.js";
import { actions } from "./state.js";

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
    for (const b of node.querySelectorAll("button")) {
      const on = b.dataset.value === value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  });
  return node;
}

/** EN / 中文 switch; switching re-renders the app through actions.setLanguage. */
export function langSwitch() {
  return segmented(t("menu.language"), LANGS.map((v) => ({ value: v, label: t(`lang.${v}`), lang: v === "zh" ? "zh-CN" : "en" })), getLang(),
    (value) => actions.setLanguage(value), "lang-seg");
}

/** Content of the account/settings menu. */
export function settingsMenu({ email = "", showSignOut = true, onSignOut } = {}) {
  return [
    email ? el("p", { class: "menu-email", text: email }) : null,
    el("p", { class: "menu-label", text: t("menu.theme") }),
    themeSwitch(),
    el("p", { class: "menu-label", text: t("menu.language") }),
    langSwitch(),
    showSignOut ? el("button", { type: "button", class: "menu-item", onclick: onSignOut }, [icon("logout"), t("menu.signOut")]) : null,
  ];
}
