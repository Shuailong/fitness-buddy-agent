// Accessible modal built on <dialog>: showModal() makes the page inert, Escape
// and the close button dismiss it, Tab is kept inside, and focus returns to
// the opener. Styled as a bottom sheet on phones and a centered card on desktop.
import { el, icon } from "./util.js";
import { t } from "./i18n.js";

let seq = 0;
const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * openModal({ title, body, cls, initialFocus, onClose }) -> { dialog, close, setBody }
 * initialFocus: element (or selector inside body) to focus first.
 */
export function openModal({ title, body, cls = "", initialFocus = null, onClose = null } = {}) {
  const opener = document.activeElement;
  const titleId = `modal-title-${++seq}`;
  const dialog = el("dialog", { class: `modal ${cls}`.trim(), "aria-labelledby": titleId });
  const closeBtn = el("button", { type: "button", class: "icon-btn modal-close", "aria-label": t("fb.close"), title: t("fb.close"), onclick: () => close() }, [icon("close")]);
  const card = el("div", { class: "modal-card" }, [
    el("header", { class: "modal-head" }, [el("h2", { class: "modal-title", id: titleId, text: title }), closeBtn]),
    body,
  ]);
  dialog.append(card);

  function close() {
    if (dialog.open) dialog.close();
  }

  // Clicks on the ::backdrop target the <dialog> itself (the card fills it).
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (onClose) onClose();
    if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
  });

  document.body.append(dialog);
  dialog.showModal();
  const target = typeof initialFocus === "string" ? dialog.querySelector(initialFocus) : initialFocus;
  const fallback = body.querySelector(FOCUSABLE);
  (target || fallback || closeBtn).focus();
  return { dialog, close };
}
