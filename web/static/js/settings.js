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
      onSettings ? item("tune", isZh ? "全部设置与教练中心" : "All Settings & Coach Studio", onSettings, "settings-primary-item") : null,
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
            el("span", { text: isZh ? `当前教练：${currentPersona.copy.shortName}` : `Coach: ${currentPersona.copy.shortName}` }),
          ])
        : null,
      onPrivacy
        ? el("button", { type: "button", class: "menu-item menu-privacy-btn", onclick: onPrivacy }, [
            icon("shield"),
            el("span", { text: isZh ? "隐私与数据共享 (PDPA)" : "Privacy & Data Controls" }),
            el("span", {
              class: `menu-pdpa-dot ${shareUsageData ? "is-on" : "is-off"}`,
              title: shareUsageData
                ? (isZh ? "已开启诊断共享" : "Usage sharing on")
                : (isZh ? "已关闭诊断共享（严格隐私模式）" : "Opted out of usage sharing"),
              text: shareUsageData ? (isZh ? "共享中" : "Shared") : (isZh ? "已关闭" : "Private"),
            }),
          ])
        : null,
      onFeedback ? item("rate-review", t("fb.menu"), onFeedback) : null,
      onExport ? item("download", t("menu.export"), onExport) : null,
    ].filter(Boolean)),
    el("div", { class: "menu-group" }, [
      onDelete ? item("delete-forever", t("menu.delete"), onDelete, "danger") : null,
      showSignOut ? item("logout", t("menu.signOut"), onSignOut) : null,
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
} = {}) {
  const isZh = getLang() === "zh";
  const me = state.me || {};
  const isAdmin = Boolean(me.is_admin);
  const activePersona = getPersona(getPersonaId(), getLang());
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
      ? (isZh ? "已开启诊断共享" : "Sharing Enabled")
      : (isZh ? "已关闭 · 严格隐私模式" : "Opted Out · Private Mode");
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
        ? (isZh
            ? "已更新偏好：允许记录匿名运行统计数据。"
            : "Preference saved: anonymous operational usage sharing is enabled.")
        : (isZh
            ? "已撤回授权：已停止发送使用统计，并已从管理后台抹除你的在线状态与历史访问记录。"
            : "Consent withdrawn: usage telemetry is disabled and your historical operational records have been purged.");
      pdpaNote.hidden = false;
      if (onPrivacyUpdated) onPrivacyUpdated(pref);
      if (showToast) {
        showToast(
          pref.share_usage_data
            ? (isZh ? "已开启使用数据共享" : "Usage data sharing enabled")
            : (isZh ? "已关闭使用数据共享并清理后台记录" : "Usage data sharing disabled & records purged"),
          { timeout: 4500 }
        );
      }
    } catch (err) {
      pdpaToggleInput.checked = !nextVal;
      syncPdpaUi(!nextVal);
      pdpaNote.className = "pdpa-feedback-note is-err";
      pdpaNote.textContent = isZh ? `保存失败：${err.message}` : `Could not update preference: ${err.message}`;
      pdpaNote.hidden = false;
    } finally {
      pdpaToggleInput.disabled = false;
    }
  });

  root.replaceChildren(
    el("header", { class: "greeting settings-header" }, [
      el("div", { class: "greeting-row" }, [
        el("div", {}, [
          el("p", { class: "eyebrow accent", text: isZh ? "偏好与隐私中心 · SETTINGS" : "PREFERENCES & PRIVACY · SETTINGS" }),
          el("h1", { text: isZh ? "设置与教练中心" : "Settings & Coach Studio" }),
        ]),
        el("span", { class: "chip" }, [
          coachAvatar(activePersona.id, { size: "sm" }),
          el("span", { text: isZh ? `当前教练：${activePersona.copy.shortName}` : `Active: ${activePersona.copy.shortName}` }),
        ]),
      ]),
      el("p", {
        class: "muted settings-sub",
        text: isZh
          ? "集中管理你的 AI 教练人设与声音、主题外观、界面语言、PDPA 隐私权限与个人数据。"
          : "Manage your AI coach persona & voice, appearance, language, PDPA privacy controls, and account data in one place.",
      }),
    ]),

    el("div", { class: "settings-stack" }, [
      // 1. AI Coach Persona & Voice Studio
      el("section", { class: "card settings-card", "aria-labelledby": "settings-coach-heading" }, [
        el("div", { class: "settings-card-head" }, [
          el("div", { class: "settings-card-title-group" }, [
            el("span", { class: "round-icon", "aria-hidden": "true" }, [icon("smart-toy")]),
            el("div", {}, [
              el("h2", { id: "settings-coach-heading", text: isZh ? "AI 教练人设与语音试听" : "AI Coach Persona & Voice" }),
              el("p", {
                class: "muted small",
                text: isZh
                  ? "选择最能激励你的教练风格并试听专属语音。切换教练不会丢失任何训练计划、饮食记录或教练记忆。"
                  : "Pick the coaching style that motivates you most and preview their voice. Switching keeps all your plans, logs, and memories.",
              }),
            ]),
          ]),
        ]),
        renderPersonaSelectorGrid({
          onSwitched: () => renderSettingsView(root, {
            onExport, onDelete, onSignOut, showSignOut, onAdmin, onFeedback, onPrivacyUpdated, showToast,
          }),
        }),
      ]),

      // 2. Appearance, Language & Product Feedback
      el("section", { class: "card settings-card", "aria-labelledby": "settings-pref-heading" }, [
        el("div", { class: "settings-card-head" }, [
          el("div", { class: "settings-card-title-group" }, [
            el("span", { class: "round-icon", "aria-hidden": "true" }, [icon("tune")]),
            el("div", {}, [
              el("h2", { id: "settings-pref-heading", text: isZh ? "外观、语言与反馈" : "Appearance, Language & Feedback" }),
              el("p", {
                class: "muted small",
                text: isZh ? "自定义深浅色主题、中英文界面与产品建议反馈。" : "Customize theme mode, display language, and send product feedback.",
              }),
            ]),
          ]),
        ]),
        el("div", { class: "settings-pref-grid" }, [
          el("div", { class: "settings-pref-item" }, [
            el("div", { class: "settings-pref-copy" }, [
              el("strong", { text: t("menu.theme") }),
              el("span", { class: "muted small", text: isZh ? "跟随系统自动切换或固定深色/浅色模式" : "Follow system appearance or lock light/dark mode" }),
            ]),
            themeSwitch(),
          ]),
          el("div", { class: "settings-pref-item" }, [
            el("div", { class: "settings-pref-copy" }, [
              el("strong", { text: t("menu.language") }),
              el("span", { class: "muted small", text: isZh ? "切换界面与教练默认回复语言 (中文 / English)" : "Switch UI and default coach response language" }),
            ]),
            langSwitch(),
          ]),
          onFeedback
            ? el("div", { class: "settings-pref-item" }, [
                el("div", { class: "settings-pref-copy" }, [
                  el("strong", { text: isZh ? "产品体验反馈" : "Product Feedback" }),
                  el("span", { class: "muted small", text: isZh ? "遇到 Bug 或有新功能建议？直接发给开发团队" : "Found a bug or have a feature idea? Tell the team" }),
                ]),
                el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: onFeedback }, [
                  icon("rate-review"),
                  el("span", { text: t("fb.menu") }),
                ]),
              ])
            : null,
        ].filter(Boolean)),
      ]),

      // 3. PDPA Privacy & Usage Data Controls
      el("section", { class: "card settings-card", "aria-labelledby": "settings-privacy-heading" }, [
        el("div", { class: "settings-card-head" }, [
          el("div", { class: "settings-card-title-group" }, [
            el("span", { class: "round-icon", "aria-hidden": "true" }, [icon("shield")]),
            el("div", {}, [
              el("h2", { id: "settings-privacy-heading", text: isZh ? "隐私保护与数据共享控制 (PDPA)" : "Privacy & Data Controls (PDPA)" }),
              el("p", {
                class: "muted small",
                text: isZh
                  ? "遵循个人数据保护法（PDPA）：你的教练对话内容严格私密，管理员绝不可见。"
                  : "Aligned with PDPA: your Coach conversations and health logs are strictly confidential and never visible to admins.",
              }),
            ]),
          ]),
          pdpaStatusBadge,
        ]),

        el("div", { class: "pdpa-boundary-grid settings-pdpa-grid" }, [
          el("div", { class: "pdpa-boundary-col is-private" }, [
            el("div", { class: "pdpa-boundary-head" }, [
              icon("check-circle"),
              el("strong", { text: isZh ? "绝对私密（后台管理员永远不可见）" : "Strictly Private (Never visible to admins)" }),
            ]),
            el("ul", { class: "pdpa-boundary-list" }, [
              el("li", { text: isZh ? "与 AI 教练的所有文字/语音聊天记录与长期记忆" : "All AI Coach text/voice chat messages & memories" }),
              el("li", { text: isZh ? "三餐饮食照片、营养分析与每日体重数据" : "Meal photos, nutrition logs & body weight entries" }),
              el("li", { text: isZh ? "实时动作指导摄像头画面（浏览器本地提取姿态关键点）" : "Live camera form-check video (processed locally in browser)" }),
            ]),
          ]),
          el("div", { class: "pdpa-boundary-col is-ops" }, [
            el("div", { class: "pdpa-boundary-head" }, [
              icon("privacy-tip"),
              el("strong", { text: isZh ? "可选运行诊断（由下方开关随时控制）" : "Optional Diagnostics (Controlled below)" }),
            ]),
            el("ul", { class: "pdpa-boundary-list" }, [
              el("li", { text: isZh ? "页面访问频次与功能点击计数（不含任何聊天正文）" : "Screen views & feature click counts (never chat text)" }),
              el("li", { text: isZh ? "AI 响应耗时与内测在线活跃状态" : "AI response latency & active beta presence indicator" }),
            ]),
          ]),
        ]),

        el("div", { class: "pdpa-toggle-card settings-pdpa-toggle" }, [
          el("div", { class: "pdpa-toggle-row" }, [
            el("div", { class: "pdpa-toggle-copy" }, [
              el("label", {
                class: "pdpa-toggle-label",
                for: "settings-pdpa-share-toggle",
                text: isZh ? "允许共享匿名使用情况与运行诊断数据" : "Share Anonymous Usage & Operational Diagnostics Data",
              }),
              el("p", {
                class: "pdpa-toggle-desc",
                text: isZh
                  ? "你可以随时关闭此开关（PDPA 第 13–16 条同意与撤回权）。关闭后完全不影响 AI 教练功能，并会立即停止采集、同时从管理后台清空你的在线与历史访问统计。"
                  : "Turn this off anytime under PDPA Sections 13–16 without affecting any Coach features. Turning it off stops telemetry and purges your historical usage & presence records.",
              }),
            ]),
            el("label", { class: "pdpa-switch", for: "settings-pdpa-share-toggle", "aria-label": isZh ? "切换是否共享使用数据" : "Toggle usage data sharing" }, [
              pdpaToggleInput,
              el("span", { class: "pdpa-switch-slider" }),
            ]),
          ]),
          pdpaNote,
        ]),
      ]),

      // 4. Account & Data Management
      el("section", { class: "card settings-card", "aria-labelledby": "settings-account-heading" }, [
        el("div", { class: "settings-card-head" }, [
          el("div", { class: "settings-card-title-group" }, [
            el("span", { class: "round-icon", "aria-hidden": "true" }, [icon("verified-user")]),
            el("div", {}, [
              el("h2", { id: "settings-account-heading", text: isZh ? "账户与数据管理" : "Account & Data Management" }),
              el("p", {
                class: "muted small",
                text: isZh ? "随时导出你在 Fitness Buddy 中的全部个人数据，或彻底注销账户。" : "Export a full copy of your Fitness Buddy data anytime or permanently delete your account.",
              }),
            ]),
          ]),
        ]),

        el("div", { class: "settings-account-row" }, [
          el("div", { class: "settings-user-card" }, [
            el("span", { class: "avatar settings-user-avatar" }, [
              me.picture
                ? el("img", { src: me.picture, alt: "", referrerpolicy: "no-referrer" })
                : el("span", { text: initials(me) }),
            ]),
            el("div", { class: "settings-user-meta" }, [
              el("div", { class: "settings-user-name-row" }, [
                el("strong", { text: me.name || me.given_name || (isZh ? "当前登录用户" : "Signed-in User") }),
                el("span", {
                  class: `pill ${isAdmin ? "pill-primary" : "pill-outline"}`,
                  text: isAdmin ? (isZh ? "管理员 · Admin" : "Admin") : (isZh ? "内测成员 · Member" : "Beta Member"),
                }),
              ]),
              el("span", { class: "muted small", text: me.email || "" }),
            ]),
          ]),

          el("div", { class: "settings-account-actions" }, [
            isAdmin && onAdmin
              ? el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: onAdmin }, [
                  icon("shield"),
                  el("span", { text: t("menu.admin") }),
                ])
              : null,
            onExport
              ? el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: onExport }, [
                  icon("download"),
                  el("span", { text: t("menu.export") }),
                ])
              : null,
            el("a", { class: "btn btn-secondary btn-sm", href: "/privacy", target: "_blank", rel: "noopener" }, [
              icon("privacy-tip"),
              el("span", { text: t("menu.privacy") }),
              icon("open-in-new"),
            ]),
            showSignOut && onSignOut
              ? el("button", { type: "button", class: "btn btn-secondary btn-sm", onclick: onSignOut }, [
                  icon("logout"),
                  el("span", { text: t("menu.signOut") }),
                ])
              : null,
            onDelete
              ? el("button", { type: "button", class: "btn btn-secondary btn-sm pdpa-del-btn", onclick: onDelete }, [
                  icon("delete-forever"),
                  el("span", { text: t("menu.delete") }),
                ])
              : null,
          ].filter(Boolean)),
        ]),
      ]),
    ]),
  );
}

