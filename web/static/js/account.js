// Account & privacy actions from the avatar menu: PDPA privacy & usage data
// sharing controls, export my data (JSON download), and delete my account.
import { el, icon, isoDate } from "./util.js";
import { api, postJson } from "./api.js";
import { t, getLang } from "./i18n.js";
import { openModal } from "./modal.js";
import { state } from "./state.js";
import { enableTelemetry } from "./telemetry.js";

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
 * PDPA Privacy & Usage Data Controls dialog.
 * Explains Coach Chat confidentiality (admins cannot read chat/photos/metrics)
 * and lets the user toggle `share_usage_data` with immediate telemetry purge on withdrawal.
 */
export function openPrivacySettingsModal({ onExport, onDelete, onUpdated, showToast } = {}) {
  const isZh = getLang() === "zh";
  const currentPref = () => !(state.me && state.me.privacy && state.me.privacy.share_usage_data === false);

  const statusBadge = el("span", { class: "pdpa-status-pill" });
  const toggleInput = el("input", {
    type: "checkbox",
    class: "pdpa-switch-input",
    id: "pdpa-share-usage-toggle",
    checked: currentPref() ? "checked" : null,
  });
  const toggleNote = el("p", { class: "pdpa-feedback-note", hidden: true });

  function syncUi(enabled) {
    toggleInput.checked = Boolean(enabled);
    statusBadge.className = `pdpa-status-pill ${enabled ? "is-on" : "is-off"}`;
    statusBadge.textContent = enabled
      ? (t("account.sharingEnabled"))
      : (t("account.optedOutPrivateMode"));
  }
  syncUi(currentPref());

  toggleInput.addEventListener("change", async () => {
    const nextVal = Boolean(toggleInput.checked);
    toggleInput.disabled = true;
    toggleNote.hidden = true;
    try {
      const res = await postJson("/api/account/privacy", { share_usage_data: nextVal });
      const pref = (res && res.privacy) || { share_usage_data: nextVal };
      if (!state.me) state.me = {};
      state.me.privacy = pref;
      enableTelemetry(Boolean(pref.share_usage_data));
      syncUi(Boolean(pref.share_usage_data));
      toggleNote.className = "pdpa-feedback-note is-ok";
      toggleNote.textContent = pref.share_usage_data
        ? (t("account.preferenceSavedAnonymousOperationalUsage"))
        : (t("account.consentWithdrawnUsageTelemetryIs"));
      toggleNote.hidden = false;
      if (onUpdated) onUpdated(pref);
      if (showToast) {
        showToast(
          pref.share_usage_data
            ? (t("account.usageDataSharingEnabled"))
            : (t("account.usageDataSharingDisabledRecords")),
          { timeout: 4500 }
        );
      }
    } catch (err) {
      toggleInput.checked = !nextVal;
      syncUi(!nextVal);
      toggleNote.className = "pdpa-feedback-note is-err";
      toggleNote.textContent = t("account.couldNotUpdatePreferenceP0", { p0: err.message });
      toggleNote.hidden = false;
    } finally {
      toggleInput.disabled = false;
    }
  });

  const body = el("div", { class: "modal-body pdpa-modal-body" }, [
    el("div", { class: "pdpa-hero-card" }, [
      el("div", { class: "pdpa-hero-badge" }, [
        icon("shield"),
        el("span", {
          text: t("account.pdpaProtectedConfidentialByDesign"),
        }),
      ]),
      el("h3", {
        class: "pdpa-hero-title",
        text: t("account.canAdministratorsSeeMyAi"),
      }),
      el("p", {
        class: "pdpa-hero-lead",
        text: t("account.noBackendAdministratorsHaveZero"),
      }),
      el("div", { class: "pdpa-boundary-grid" }, [
        el("div", { class: "pdpa-boundary-col is-private" }, [
          el("div", { class: "pdpa-boundary-head" }, [
            icon("check-circle"),
            el("strong", {
              text: t("account.strictlyPrivateNeverVisibleTo"),
            }),
          ]),
          el("ul", { class: "pdpa-boundary-list" }, [
            el("li", { text: t("account.allAiCoachTextVoice") }),
            el("li", { text: t("account.mealPhotosNutritionBreakdownsCalorie") }),
            el("li", { text: t("account.bodyWeightMeasurementsPersonalGoals") }),
            el("li", { text: t("account.liveCameraFormCheckVideo") }),
          ]),
        ]),
        el("div", { class: "pdpa-boundary-col is-ops" }, [
          el("div", { class: "pdpa-boundary-head" }, [
            icon("privacy-tip"),
            el("strong", {
              text: t("account.optionalDiagnosticsControlledBelow"),
            }),
          ]),
          el("ul", { class: "pdpa-boundary-list" }, [
            el("li", { text: t("account.highLevelScreenViewsFeature") }),
            el("li", { text: t("account.aiResponseLatencyToolCall") }),
            el("li", { text: t("account.activeBetaPresenceIndicatorUsed") }),
          ]),
        ]),
      ]),
    ]),

    el("div", { class: "pdpa-toggle-card" }, [
      el("div", { class: "pdpa-toggle-row" }, [
        el("div", { class: "pdpa-toggle-copy" }, [
          el("div", { class: "pdpa-toggle-title-row" }, [
            el("label", {
              class: "pdpa-toggle-label",
              for: "pdpa-share-usage-toggle",
              text: t("account.shareUsageOperationalDiagnosticsData"),
            }),
            statusBadge,
          ]),
          el("p", {
            class: "pdpa-toggle-desc",
            text: t("account.inAccordanceWithPdpaSections"),
          }),
        ]),
        el("label", { class: "pdpa-switch", for: "pdpa-share-usage-toggle", "aria-label": t("account.toggleUsageDataSharing") }, [
          toggleInput,
          el("span", { class: "pdpa-switch-slider" }),
        ]),
      ]),
      toggleNote,
    ]),

    el("div", { class: "pdpa-rights-bar" }, [
      el("div", { class: "pdpa-rights-links" }, [
        onExport
          ? el("button", {
              type: "button",
              class: "btn btn-secondary btn-sm",
              onclick: () => { modal.close(); onExport(); },
            }, [icon("download"), el("span", { text: t("account.exportMyDataJson") })])
          : null,
        el("a", {
          class: "btn btn-secondary btn-sm",
          href: "/privacy",
          target: "_blank",
          rel: "noopener",
        }, [icon("open-in-new"), el("span", { text: t("account.fullPrivacyPolicy") })]),
        onDelete
          ? el("button", {
              type: "button",
              class: "btn btn-secondary btn-sm pdpa-del-btn",
              onclick: () => { modal.close(); onDelete(); },
            }, [icon("delete-forever"), el("span", { text: t("account.deleteAccount") })])
          : null,
      ].filter(Boolean)),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onclick: () => modal.close(),
      }, [t("account.done")]),
    ]),
  ]);

  const modal = openModal({
    title: t("account.privacyDataControlsPdpa"),
    body,
    cls: "pdpa-modal",
    initialFocus: toggleInput,
  });
  return modal;
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
    lang: t("meta.htmlLang"),
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
