// Applies the saved theme and language before first paint (classic, synchronous
// script; CSP forbids inline scripts). Default theme is dark; an explicit
// "system" choice removes the attribute so the OS setting applies.
(function () {
  var root = document.documentElement;
  function stored(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  var theme = stored("fb.theme");
  if (theme !== "light" && theme !== "system") theme = "dark";
  if (theme !== "system") root.setAttribute("data-theme", theme);
  var lang = stored("fb.lang");
  if (lang !== "en" && lang !== "zh") {
    lang = String(navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  }
  root.lang = lang === "zh" ? "zh-CN" : "en";

  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function syncThemeColor() {
    var effective = root.getAttribute("data-theme") || (mq && mq.matches ? "light" : "dark");
    var color = effective === "light" ? "#F8FAFC" : "#0F1215";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && meta.getAttribute("content") === color) return;
    // Replace the element (not just its attribute): the iOS home-screen app
    // only re-reads the status bar color when a theme-color meta is inserted.
    var fresh = document.createElement("meta");
    fresh.setAttribute("name", "theme-color");
    fresh.setAttribute("content", color);
    if (meta && meta.parentNode) meta.parentNode.replaceChild(fresh, meta);
    else document.head.appendChild(fresh);
  }
  window.fbSyncThemeColor = syncThemeColor;
  syncThemeColor();
  if (mq && mq.addEventListener) mq.addEventListener("change", syncThemeColor);

  // Viewport sizes at the very first script run (before any resize), for the
  // screen diagnostics in Settings.
  try {
    window.__fbVpBoot = {
      ih: window.innerHeight, iw: window.innerWidth, sh: screen.height, sw: screen.width,
      vvh: window.visualViewport ? Math.round(window.visualViewport.height) : -1,
      ch: document.documentElement.clientHeight,
    };
  } catch (e) {}

  // Kick off early parallel API fetches in <head> while CSS & ES modules download.
  try {
    if (typeof window.fetch === "function") {
      window.__fbBootPrefetch = {
        config: window.fetch("/api/config", { credentials: "same-origin" }).then(function (r) {
          return r && r.ok ? r.json() : null;
        }).catch(function () { return null; }),
        me: window.fetch("/api/me", { credentials: "same-origin" }).then(function (r) {
          return r && r.ok ? r.json() : null;
        }).catch(function () { return null; }),
        dashboard: window.fetch("/api/dashboard?range=30", { credentials: "same-origin" }).then(function (r) {
          return r && r.ok ? r.json() : null;
        }).catch(function () { return null; }),
      };
    }
  } catch (e) {}
})();
