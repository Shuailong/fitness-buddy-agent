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
})();
