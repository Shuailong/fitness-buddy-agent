// Manual theme switch: "system" (no attribute), "light" or "dark" (default).
const STORE_KEY = "fb.theme";
export const THEMES = ["system", "light", "dark"];

export function getTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" ? attr : "system";
}

export function setTheme(theme) {
  const value = THEMES.includes(theme) ? theme : "dark";
  if (value === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", value);
  try { localStorage.setItem(STORE_KEY, value); } catch (_) { /* storage disabled */ }
  if (typeof window.fbSyncThemeColor === "function") window.fbSyncThemeColor();
  return value;
}
