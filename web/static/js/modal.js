// Accessible modal built on <dialog>: showModal() makes the page inert, Escape
// and the close button dismiss it, Tab is kept inside, and focus returns to
// the opener. Styled as a bottom sheet on phones and a centered card on desktop.
import { $, el, icon } from "./util.js";
import { t } from "./i18n.js";

let seq = 0;
let activeDialog = null;
const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Closes the currently open modal dialog if any.
 */
export function closeModal() {
  if (activeDialog && activeDialog.open) {
    activeDialog.close();
  }
}

/**
 * Shows a toast banner in #toast-region with automatic dismissal.
 */
export function showToast(message, { onClick = null, timeout = 4500, iconName = "check-circle" } = {}) {
  const region = $("toast-region");
  if (!region) return;
  region.replaceChildren();
  const close = () => {
    toast.classList.add("leaving");
    setTimeout(() => toast.remove(), 200);
  };
  const toast = el("div", { class: "toast" }, [
    el("button", {
      type: "button",
      class: "toast-main",
      onclick: () => {
        close();
        if (onClick) onClick();
      },
    }, [
      icon(iconName),
      el("span", { text: message }),
      onClick ? el("span", { class: "toast-action", text: t("toast.view") }) : null,
    ]),
    el("button", {
      type: "button",
      class: "toast-close",
      "aria-label": t("toast.dismiss"),
      onclick: close,
    }, [icon("close")]),
  ]);
  region.append(toast);
  setTimeout(() => {
    if (toast.isConnected) close();
  }, timeout);
}

/**
 * openModal({ title, body, cls, initialFocus, onClose } | customCardElement) -> { dialog, close }
 */
export function openModal(arg = {}) {
  if (activeDialog && activeDialog.open) {
    activeDialog.close();
  }
  const opener = document.activeElement;
  const isNode = typeof Node !== "undefined" && arg instanceof Node;

  let dialog;
  let card;
  let closeBtn = null;
  let initialFocus = null;
  let onClose = null;

  if (isNode) {
    card = arg;
    if (!card.classList.contains("modal-card")) {
      card.classList.add("modal-card");
    }
    dialog = el("dialog", { class: "modal" }, [card]);
    closeBtn = card.querySelector(".modal-head .icon-btn, .modal-close");
  } else {
    const { title = "", subtitle = null, headerBadge = null, body, cls = "" } = arg;
    initialFocus = arg.initialFocus || null;
    onClose = arg.onClose || null;
    const titleId = `modal-title-${++seq}`;
    dialog = el("dialog", { class: `modal ${cls}`.trim(), "aria-labelledby": titleId });
    closeBtn = el("button", {
      type: "button",
      class: "icon-btn modal-close",
      "aria-label": t("fb.close"),
      title: t("fb.close"),
      onclick: () => close(),
    }, [icon("close")]);
    const headLeft = subtitle || headerBadge
      ? el("div", { class: "modal-title-group" }, [
          subtitle ? el("p", { class: "eyebrow accent", text: subtitle }) : null,
          el("div", { class: "modal-title-row" }, [
            el("h2", { class: "modal-title", id: titleId, text: title }),
            headerBadge,
          ]),
        ])
      : el("h2", { class: "modal-title", id: titleId, text: title });
    card = el("div", { class: "modal-card" }, [
      el("header", { class: "modal-head" }, [headLeft, closeBtn]),
      body,
    ]);
    dialog.append(card);
  }

  function close() {
    if (dialog.open) dialog.close();
  }

  activeDialog = dialog;

  // Clicks on the ::backdrop target the <dialog> itself.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(
      (n) => n.offsetParent !== null || n === document.activeElement,
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener("close", () => {
    if (activeDialog === dialog) activeDialog = null;
    dialog.remove();
    if (onClose) onClose();
    if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
  });

  document.body.append(dialog);
  dialog.showModal();
  const target = typeof initialFocus === "string" ? dialog.querySelector(initialFocus) : initialFocus;
  const fallback = card.querySelector(FOCUSABLE);
  if (target || fallback || closeBtn) {
    (target || fallback || closeBtn).focus();
  }
  return { dialog, close };
}

/** Opens a full-size photo preview lightbox modal. */
export function openPhotoLightbox(src, caption = "") {
  if (!src) return null;
  const img = el("img", { class: "lightbox-img", src, alt: caption || "" });
  const body = el("div", { class: "modal-body lightbox-body" }, [
    el("div", { class: "lightbox-stage" }, [img]),
    caption ? el("p", { class: "lightbox-caption muted small", text: caption }) : null,
  ]);
  return openModal({
    title: caption || t("coach.photo"),
    body,
    cls: "photo-lightbox-modal",
  });
}
