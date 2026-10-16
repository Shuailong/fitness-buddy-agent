// Privacy page (/privacy): theme toggle and EN / 中文 switch. The policy text
// for both languages is static HTML; CSS shows the one matching <html lang>,
// which theme-boot.js sets before first paint.
import { $ } from "./util.js";
import { setLang, detectLang, applyStatic, t } from "./i18n.js";
import { themeToggle, langSwitch, refreshThemeToggles } from "./settings.js";
import { actions } from "./state.js";

function render() {
  applyStatic();
  document.title = t("priv.docTitle");
  $("priv-lang").replaceChildren(langSwitch());
  refreshThemeToggles();
}

actions.setLanguage = (lang) => {
  setLang(lang);
  render();
};

setLang(detectLang(), { persist: false });
$("priv-theme").replaceChildren(themeToggle());
render();
