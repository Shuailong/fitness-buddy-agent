// /install: a platform-aware guide to add Fitness Buddy to the home screen.
// Auto-detects iPhone / Android / desktop / in-app browsers (WeChat etc.),
// offers one-tap install where the browser supports it, and a QR code on desktop.
import { $, el, icon } from "./util.js";
import { setLang, detectLang, getLang } from "./i18n.js";
import { themeToggle, langSwitch, refreshThemeToggles } from "./settings.js";
import { actions } from "./state.js";
import { detectPlatform, isStandalone, canPromptInstall, promptInstall, onInstallStateChange, registerServiceWorker } from "./pwa.js";

const COPY = {
  en: {
    title: "Install · Fitness Buddy",
    heading: "Put your coach on your home screen",
    lead: "Opens full-screen like a native app - no app store, about 10 seconds.",
    perks: ["Full-screen app", "One tap to open", "Under 1 MB", "Always up to date"],
    tabs: { ios: "iPhone", android: "Android", desktop: "Computer" },
    otherBrowser: "another browser",
    detected: (d) => `Detected: ${d}`,
    oneTap: "Install now",
    oneTapSub: "Your browser supports one-tap install.",
    iosSafari: [
      ["ios-share", "Tap the Share button", (iPad) => iPad ? "Top-right of Safari's address bar." : "In Safari's bottom toolbar (or tap the address bar first if the toolbar is hidden)."],
      ["add-box", "Choose “Add to Home Screen”", () => "Scroll down the share sheet if you don't see it right away."],
      ["check-circle", "Tap “Add”", () => "Fitness Buddy appears on your home screen - open it from there."],
    ],
    iosOther: (b) => `You're using ${b}. Tap the Share button next to the address bar and follow the same steps. If “Add to Home Screen” isn't listed, open this page in Safari.`,
    android: [
      ["more-vert", "Open the browser menu", () => "Tap ⋮ at the top-right of Chrome (Samsung Internet: ≡ at the bottom)."],
      ["install-mobile", "Tap “Install app” or “Add to Home screen”", () => "The name depends on your browser version."],
      ["check-circle", "Confirm “Install”", () => "The Fitness Buddy icon is added to your home screen and app drawer."],
    ],
    desktopLead: "Scan with your phone's camera to open this guide on your phone.",
    desktopInstall: "Prefer your computer? In Chrome or Edge, click the install icon at the right of the address bar.",
    inAppTitle: (app) => `${app} can't install apps`,
    inAppBody: (os) => os === "ios" ? "Tap ··· at the top-right and choose “Open in Safari”, then follow the steps." : "Tap ··· at the top-right and choose “Open in browser”, then follow the steps.",
    copyLink: "Copy link",
    copied: "Link copied",
    installedTitle: "Installed - you're using the app",
    installedBody: "Fitness Buddy is on your home screen. Open it any time from there.",
    justInstalled: "Done! Fitness Buddy is now on your home screen.",
    open: "Open Fitness Buddy",
    faqTitle: "Good to know",
    faq: [
      ["How does it update?", "Automatically - every time you open it you get the latest version."],
      ["Is my data synced?", "Yes. Sign in with the same Google account; phone and computer share your coach, plans and memory."],
      ["How do I remove it?", "Long-press the icon and choose Remove / Uninstall, like any app."],
    ],
  },
  zh: {
    title: "安装到手机 · Fitness Buddy",
    heading: "把教练装到手机桌面",
    lead: "像原生 App 一样全屏打开，无需应用商店，约 10 秒完成。",
    perks: ["全屏 App 体验", "桌面一键打开", "不到 1 MB", "自动更新"],
    tabs: { ios: "iPhone", android: "安卓", desktop: "电脑" },
    otherBrowser: "其他浏览器",
    detected: (d) => `检测到：${d}`,
    oneTap: "一键安装",
    oneTapSub: "你的浏览器支持一键安装。",
    iosSafari: [
      ["ios-share", "点击「分享」按钮", (iPad) => iPad ? "在 Safari 地址栏右上角。" : "在 Safari 底部工具栏（若工具栏隐藏，先轻点一下地址栏）。"],
      ["add-box", "选择「添加到主屏幕」", () => "如果没看到，在分享菜单里向下滑动。"],
      ["check-circle", "点击右上角「添加」", () => "桌面出现 Fitness Buddy 图标，之后从桌面打开即可。"],
    ],
    iosOther: (b) => `你正在使用 ${b}：点击地址栏旁的「分享」按钮，按同样步骤操作。如果菜单里没有「添加到主屏幕」，请用 Safari 打开本页。`,
    android: [
      ["more-vert", "打开浏览器菜单", () => "点击 Chrome 右上角的 ⋮（三星浏览器为底部 ≡）。"],
      ["install-mobile", "选择「安装应用」或「添加到主屏幕」", () => "不同浏览器版本名称略有不同。"],
      ["check-circle", "确认「安装」", () => "Fitness Buddy 图标会出现在桌面和应用列表中。"],
    ],
    desktopLead: "用手机相机扫码，在手机上打开本安装指南。",
    desktopInstall: "想在电脑上用？Chrome / Edge 中点击地址栏右侧的「安装」图标即可。",
    inAppTitle: (app) => `${app} 内无法安装`,
    inAppBody: (os) => os === "ios" ? "点击右上角 ···，选择「在 Safari 中打开」，再按步骤操作。" : "点击右上角 ···，选择「在浏览器中打开」，再按步骤操作。",
    copyLink: "复制链接",
    copied: "链接已复制",
    installedTitle: "已安装，你正在使用 App 版本",
    installedBody: "Fitness Buddy 已在桌面，随时从桌面图标打开。",
    justInstalled: "安装完成！Fitness Buddy 已添加到桌面。",
    open: "打开 Fitness Buddy",
    faqTitle: "常见问题",
    faq: [
      ["安装后怎么更新？", "自动更新，每次打开都是最新版本。"],
      ["数据会同步吗？", "会。用同一个 Google 账号登录，手机和电脑共享教练、计划和记忆。"],
      ["怎么卸载？", "和普通 App 一样，长按桌面图标选择「移除」即可。"],
    ],
  },
};

const BROWSER_NAMES = { safari: "Safari", chrome: "Chrome", edge: "Edge", firefox: "Firefox", samsung: "Samsung Internet", other: "" };
const platform = detectPlatform();
let activeTab = platform.os;
let justInstalled = false;

const c = () => COPY[getLang() === "zh" ? "zh" : "en"];

function steps(list) {
  return el("ol", { class: "inst-steps" }, list.map(([ic, title, sub], i) =>
    el("li", { class: "inst-step" }, [
      el("span", { class: "inst-step-num", text: String(i + 1) }),
      el("span", { class: "inst-step-icon", "aria-hidden": "true" }, [icon(ic)]),
      el("div", { class: "inst-step-text" }, [
        el("strong", { text: title }),
        el("span", { class: "muted small", text: sub(platform.iPad) }),
      ]),
    ])));
}

function copyLinkBtn() {
  const btn = el("button", { type: "button", class: "btn btn-secondary btn-sm" }, [icon("content-copy"), el("span", { text: c().copyLink })]);
  btn.addEventListener("click", async () => {
    const url = `${location.origin}/install`;
    try { await navigator.clipboard.writeText(url); } catch {
      const ta = el("textarea", { style: { position: "fixed", opacity: "0" } }); ta.value = url; document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    btn.lastElementChild.textContent = c().copied;
    setTimeout(() => { btn.lastElementChild.textContent = c().copyLink; }, 2000);
  });
  return btn;
}

function oneTapCard() {
  if (!canPromptInstall()) return null;
  const btn = el("button", { type: "button", class: "btn btn-primary btn-xl inst-one-tap" }, [icon("download"), c().oneTap]);
  btn.addEventListener("click", async () => {
    const outcome = await promptInstall();
    if (outcome === "accepted") { justInstalled = true; }
    render();
  });
  return el("div", { class: "inst-one-tap-card" }, [btn, el("p", { class: "muted small", text: c().oneTapSub })]);
}

function panel() {
  const t = c();
  if (activeTab === "ios") {
    const nonSafari = platform.os === "ios" && platform.browser !== "safari" && !platform.inApp;
    return el("div", { class: "inst-panel" }, [
      nonSafari ? el("p", { class: "inst-note" }, [icon("warning"), el("span", { text: t.iosOther(BROWSER_NAMES[platform.browser] || t.otherBrowser) })]) : null,
      steps(t.iosSafari),
      nonSafari ? copyLinkBtn() : null,
    ]);
  }
  if (activeTab === "android") {
    return el("div", { class: "inst-panel" }, [platform.os === "android" ? oneTapCard() : null, steps(t.android)]);
  }
  return el("div", { class: "inst-panel inst-desktop" }, [
    el("div", { class: "inst-qr" }, [
      el("img", { src: "/static/img/install-qr.svg", alt: "QR code: fitnessbuddy.online/install", width: "196", height: "196" }),
      el("p", { class: "inst-qr-url", text: "fitnessbuddy.online/install" }),
    ]),
    el("div", { class: "inst-desktop-text" }, [
      el("p", { class: "inst-desktop-lead", text: t.desktopLead }),
      el("p", { class: "muted small", text: t.desktopInstall }),
      platform.os === "desktop" ? oneTapCard() : null,
    ]),
  ]);
}

function render() {
  const t = c();
  document.title = t.title;
  $("inst-lang").replaceChildren(langSwitch());
  refreshThemeToggles();
  const main = $("inst-main");
  const hero = el("section", { class: "inst-hero" }, [
    el("img", { class: "inst-app-icon", src: "/static/img/app/icon-192.png", alt: "", width: "84", height: "84" }),
    el("h1", { text: t.heading }),
    el("p", { class: "inst-lead", text: t.lead }),
    el("ul", { class: "inst-perks" }, t.perks.map((p) => el("li", {}, [icon("check-circle"), el("span", { text: p })]))),
  ]);

  if (isStandalone() || justInstalled) {
    main.replaceChildren(hero, el("section", { class: "card inst-done" }, [
      el("span", { class: "inst-done-icon", "aria-hidden": "true" }, [icon("check-circle")]),
      el("h2", { text: justInstalled ? t.justInstalled : t.installedTitle }),
      justInstalled ? null : el("p", { class: "muted", text: t.installedBody }),
      el("a", { class: "btn btn-primary", href: "/" }, [t.open]),
    ]));
    return;
  }

  const blocks = [hero];
  if (platform.inApp) {
    blocks.push(el("section", { class: "card inst-inapp" }, [
      el("div", { class: "inst-inapp-head" }, [icon("warning"), el("h2", { text: t.inAppTitle(platform.inApp) })]),
      el("p", { text: t.inAppBody(platform.os) }),
      el("div", { class: "inst-inapp-hint", "aria-hidden": "true", text: "···  ↗" }),
      copyLinkBtn(),
    ]));
  }
  const detectedLabel = `${t.tabs[platform.os]}${BROWSER_NAMES[platform.browser] ? ` · ${BROWSER_NAMES[platform.browser]}` : ""}${platform.inApp ? ` · ${platform.inApp}` : ""}`;
  blocks.push(el("section", { class: "card inst-guide" }, [
    el("div", { class: "inst-tabs", role: "tablist" }, ["ios", "android", "desktop"].map((k) =>
      el("button", {
        type: "button", role: "tab", class: `inst-tab${k === activeTab ? " active" : ""}`, "aria-selected": String(k === activeTab),
        onclick: () => { activeTab = k; render(); },
      }, [icon(k === "desktop" ? "computer" : "smartphone"), el("span", { text: t.tabs[k] })]))),
    el("p", { class: "inst-detected muted small", text: t.detected(detectedLabel) }),
    panel(),
  ]));
  blocks.push(el("section", { class: "inst-faq" }, [
    el("h2", { text: t.faqTitle }),
    el("div", { class: "inst-faq-grid" }, t.faq.map(([q, a]) => el("div", { class: "inst-faq-item" }, [el("strong", { text: q }), el("p", { class: "muted small", text: a })]))),
  ]));
  blocks.push(el("a", { class: "link-btn inst-open-web", href: "/" }, [t.open, icon("arrow-forward")]));
  main.replaceChildren(...blocks);
}

actions.setLanguage = (lang) => { setLang(lang); render(); };
setLang(detectLang(), { persist: false });
$("inst-theme").replaceChildren(themeToggle());
registerServiceWorker();
onInstallStateChange(() => render());
window.addEventListener("appinstalled", () => { justInstalled = true; render(); });
render();
