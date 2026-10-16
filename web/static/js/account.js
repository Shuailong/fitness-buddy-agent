// Account & privacy actions from the avatar menu: export my data (JSON
// download) and delete my account (typed confirmation).
import { el, icon, isoDate } from "./util.js";
import { api, postJson } from "./api.js";
import { t, getLang } from "./i18n.js";
import { openModal } from "./modal.js";

/** GET /api/account/export and save it with the server's file name. */
export async function exportData() {
  const res = await api("/api/account/export");
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  let name = `fitness-buddy-export-${isoDate(new Date())}.json`;
  if (match) { try { name = decodeURIComponent(match[1]); } catch (_) { name = match[1]; } }
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

/** The typed confirmation: "DELETE" in any language, or the localized word (删除). */
export function isDeleteWord(value) {
  const v = String(value || "").trim();
  return v.toUpperCase() === "DELETE" || v === t("del.word");
}

/**
 * Confirm dialog listing exactly what is deleted. The button stays disabled
 * until the user types the confirmation word. The server always gets "DELETE".
 * opts: { onExport(): Promise, onDeleted() }
 */
export function openDeleteDialog({ onExport, onDeleted } = {}) {
  const inputId = "del-confirm-input";
  const word = t("del.word");
  const input = el("input", {
    id: inputId, class: "text-input", type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false",
    lang: getLang() === "zh" ? "zh-CN" : "en",
  });
  const error = el("p", { class: "fb-error", role: "alert", hidden: true });
  const deleteBtn = el("button", { type: "submit", class: "btn btn-danger", disabled: true }, [icon("delete-forever"), t("del.confirm")]);
  input.addEventListener("input", () => { deleteBtn.disabled = !isDeleteWord(input.value); error.hidden = true; });

  const exportBtn = onExport ? el("button", { type: "button", class: "link-btn del-export" }, [icon("download"), t("del.exportFirst")]) : null;
  if (exportBtn) exportBtn.addEventListener("click", () => onExport());

  const form = el("form", { class: "modal-body del-form", novalidate: true }, [
    el("p", { text: t("del.intro") }),
    el("ul", { class: "del-list" }, ["del.i1", "del.i2", "del.i3", "del.i4", "del.i5"].map((k) => el("li", {}, [icon("remove"), t(k)]))),
    el("p", { class: "del-note" }, [icon("warning"), t("del.note")]),
    exportBtn,
    el("label", { class: "modal-q", for: inputId, text: t("del.typeLabel", { word }) }),
    input,
    error,
    el("div", { class: "modal-actions" }, [
      el("button", { type: "button", class: "btn btn-secondary", onclick: () => modal.close() }, [t("fb.cancel")]),
      deleteBtn,
    ]),
  ]);

  const modal = openModal({ title: t("del.title"), body: form, cls: "del-modal", initialFocus: input });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isDeleteWord(input.value)) return;
    deleteBtn.disabled = true;
    input.disabled = true;
    deleteBtn.replaceChildren(t("del.deleting"));
    try {
      await postJson("/api/account/delete", { confirm: "DELETE" });
      modal.close();
      if (onDeleted) onDeleted();
    } catch (err) {
      input.disabled = false;
      deleteBtn.disabled = false;
      deleteBtn.replaceChildren(icon("delete-forever"), t("del.confirm"));
      error.textContent = t("del.error", { message: err.message });
      error.hidden = false;
    }
  });
  return modal;
}
