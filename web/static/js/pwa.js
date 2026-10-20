// Home-screen install helpers shared by the app shell and the /install page:
// service worker registration, the deferred Chrome install prompt, and
// platform / browser detection for the right step-by-step guide.

let deferredPrompt = null;
const listeners = new Set();

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    for (const fn of listeners) fn();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    try { localStorage.setItem("fb.installed", "1"); } catch { /* ignore */ }
    for (const fn of listeners) fn();
  });
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* optional */ });
}

export const onInstallStateChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const canPromptInstall = () => Boolean(deferredPrompt);

/** Shows Chrome/Edge's native install dialog; resolves to "accepted" | "dismissed" | "unavailable". */
export async function promptInstall() {
  if (!deferredPrompt) return "unavailable";
  const p = deferredPrompt;
  deferredPrompt = null;
  p.prompt();
  try {
    const { outcome } = await p.userChoice;
    return outcome;
  } finally {
    for (const fn of listeners) fn();
  }
}

export function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

/** { os: ios|android|desktop, browser: safari|chrome|edge|firefox|samsung|other, inApp: name|null } */
export function detectPlatform(ua = navigator.userAgent) {
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const os = /iPhone|iPad|iPod/.test(ua) || iPadOS ? "ios" : /Android/.test(ua) ? "android" : "desktop";
  const inAppMatch = ua.match(/MicroMessenger|WeChat|Weibo|QQ\/|FBAN|FBAV|Instagram|Line\/|LinkedInApp|Twitter|DingTalk|Lark|Feishu/i);
  let browser = "other";
  if (/SamsungBrowser/i.test(ua)) browser = "samsung";
  else if (/EdgiOS|EdgA|Edg\//.test(ua)) browser = "edge";
  else if (/CriOS|Chrome\//.test(ua)) browser = "chrome";
  else if (/FxiOS|Firefox\//.test(ua)) browser = "firefox";
  else if (/Safari\//.test(ua) && os === "ios") browser = "safari";
  else if (/Safari\//.test(ua)) browser = "safari";
  const inApp = inAppMatch ? (/MicroMessenger|WeChat/i.test(inAppMatch[0]) ? "WeChat" : inAppMatch[0].replace(/\/$/, "")) : null;
  return { os, browser, inApp, iPad: /iPad/.test(ua) || iPadOS };
}
