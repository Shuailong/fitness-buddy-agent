// Manual theme switch: "system" (no attribute), "light" or "dark".
const STORE_KEY = "fb.theme";
export const THEMES = ["system", "light", "dark"];
export const THEME_EVENT = "fb-theme-change";

export function getTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" ? attr : "system";
}

/** The theme actually shown: the manual choice, else the system preference. */
export function effectiveTheme() {
  const theme = getTheme();
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function animateColors() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const root = document.documentElement;
  root.classList.add("theme-anim");
  clearTimeout(animateColors.timer);
  animateColors.timer = setTimeout(() => root.classList.remove("theme-anim"), 400);
}

export function setTheme(theme) {
  const value = THEMES.includes(theme) ? theme : "system";
  animateColors();
  if (value === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", value);
  try { localStorage.setItem(STORE_KEY, value); } catch (_) { /* storage disabled */ }
  if (typeof window.fbSyncThemeColor === "function") window.fbSyncThemeColor();
  document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: value } }));
  return value;
}

/** One-click dark <-> light switch (the menus still offer "System"). */
export function toggleTheme() {
  return setTheme(effectiveTheme() === "dark" ? "light" : "dark");
}

// Following the system: tell listeners when the OS theme flips.
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (getTheme() === "system") document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: "system" } }));
});
