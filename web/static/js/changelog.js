// /changelog: "What's new" - user-facing release notes (data in changelog-data.js).
import { $, el, icon } from "./util.js";
import { setLang, detectLang, getLang } from "./i18n.js";
import { themeToggle, langSwitch, refreshThemeToggles } from "./settings.js";
import { actions } from "./state.js";
import { registerServiceWorker } from "./pwa.js";
import { CHANGELOG, markChangelogSeen } from "./changelog-data.js";

const COPY = {
  en: {
    title: "What's new · Fitness Buddy",
    heading: "What's new",
    lead: "New features, improvements and fixes in Fitness Buddy.",
    back: "Back to the app",
    types: { new: "New", improved: "Improved", fixed: "Fixed" },
    filterAll: "All",
    latest: "Latest",
  },
  zh: {
    title: "更新日志 · Fitness Buddy",
    heading: "更新日志",
    lead: "Fitness Buddy 的新功能、改进和修复。",
    back: "返回应用",
    types: { new: "新功能", improved: "改进", fixed: "修复" },
    filterAll: "全部",
    latest: "最新",
  },
};
const TYPE_ICONS = { new: "auto-awesome", improved: "trending-up", fixed: "check-circle" };
let filter = "all";

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return getLang() === "zh"
    ? `${y} 年 ${m} 月 ${d} 日`
    : date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function render() {
  const lang = getLang() === "zh" ? "zh" : "en";
  const t = COPY[lang];
  document.title = t.title;
  $("clog-lang").replaceChildren(langSwitch());
  refreshThemeToggles();
  const filters = el("div", { class: "segmented clog-filters", role: "group" }, ["all", "new", "improved", "fixed"].map((key) =>
    el("button", {
      type: "button",
      class: key === filter ? "active" : "",
      "aria-pressed": String(key === filter),
      onclick: () => { filter = key; render(); },
    }, [key === "all" ? t.filterAll : t.types[key]])));
  const releases = CHANGELOG.map((release, index) => {
    const items = release.items.filter((it) => filter === "all" || it.type === filter);
    if (!items.length) return null;
    return el("article", { class: "clog-release", id: release.id }, [
      el("div", { class: "clog-rail", "aria-hidden": "true" }, [el("span", { class: "clog-dot" })]),
      el("div", { class: "clog-body" }, [
        el("p", { class: "clog-date" }, [
          el("time", { datetime: release.date, text: formatDate(release.date) }),
          index === 0 ? el("span", { class: "pill pill-primary clog-latest", text: t.latest }) : null,
        ]),
        el("h2", { class: "clog-title", text: release.title[lang] }),
        el("ul", { class: "clog-items" }, items.map((it) => el("li", { class: `clog-item is-${it.type}` }, [
          el("span", { class: `clog-tag is-${it.type}` }, [icon(TYPE_ICONS[it.type]), t.types[it.type]]),
          el("span", { class: "clog-text", text: it[lang] }),
        ]))),
      ]),
    ]);
  }).filter(Boolean);
  $("clog-main").replaceChildren(
    el("a", { class: "link-btn priv-back", href: "/" }, [icon("arrow-back"), t.back]),
    el("header", { class: "clog-head" }, [el("h1", { text: t.heading }), el("p", { class: "clog-lead muted", text: t.lead }), filters]),
    el("div", { class: "clog-list" }, releases),
  );
}

actions.setLanguage = (lang) => { setLang(lang); render(); };
setLang(detectLang(), { persist: false });
$("clog-theme").replaceChildren(themeToggle());
render();
markChangelogSeen();
registerServiceWorker();
