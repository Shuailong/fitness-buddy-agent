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
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", effective === "light" ? "#F8FAFC" : "#0F1215");
  }
  window.fbSyncThemeColor = syncThemeColor;
  syncThemeColor();
  if (mq && mq.addEventListener) mq.addEventListener("change", syncThemeColor);

  // iOS home-screen app cold start: WebKit reports a viewport that is short by
  // the status-bar height until the next resize, so a full-height layout ends
  // above the bottom of the screen. In standalone portrait the app always owns
  // the whole screen, so use the screen height when the viewport is shorter.
  function syncAppHeight() {
    var standalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    var portrait = window.matchMedia && window.matchMedia("(orientation: portrait)").matches;
    var h = window.innerHeight;
    if (standalone && portrait && window.screen && screen.width === window.innerWidth && screen.height > h) h = screen.height;
    root.style.setProperty("--app-h", h + "px");
  }
  syncAppHeight();
  window.addEventListener("resize", syncAppHeight);
  window.addEventListener("orientationchange", function () { setTimeout(syncAppHeight, 250); });
  window.addEventListener("pageshow", syncAppHeight);

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
