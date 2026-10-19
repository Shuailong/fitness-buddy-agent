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
      ? (isZh ? "已开启诊断共享" : "Sharing Enabled")
      : (isZh ? "已关闭 · 后台记录已隐去" : "Opted Out · Private Mode");
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
        ? (isZh
            ? "已更新偏好：允许记录匿名运行统计数据。"
            : "Preference saved: anonymous operational usage sharing is enabled.")
        : (isZh
            ? "已撤回授权：已停止发送使用统计，并已从管理后台抹除你的在线状态与历史访问记录。"
            : "Consent withdrawn: usage telemetry is disabled and your historical operational records have been purged.");
      toggleNote.hidden = false;
      if (onUpdated) onUpdated(pref);
      if (showToast) {
        showToast(
          pref.share_usage_data
            ? (isZh ? "已开启使用数据共享" : "Usage data sharing enabled")
            : (isZh ? "已关闭使用数据共享并清理后台记录" : "Usage data sharing disabled & records purged"),
          { timeout: 4500 }
        );
      }
    } catch (err) {
      toggleInput.checked = !nextVal;
      syncUi(!nextVal);
      toggleNote.className = "pdpa-feedback-note is-err";
      toggleNote.textContent = isZh
        ? `保存失败：${err.message}`
        : `Could not update preference: ${err.message}`;
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
          text: isZh ? "PDPA 隐私保护承诺 · 默认严格隔离" : "PDPA Protected · Confidential by Design",
        }),
      ]),
      el("h3", {
        class: "pdpa-hero-title",
        text: isZh
          ? "后台管理员能看到我和 AI 教练的聊天内容吗？"
          : "Can administrators see my AI Coach conversations?",
      }),
      el("p", {
        class: "pdpa-hero-lead",
        text: isZh
          ? "绝对不能。管理后台（Admin Console）没有任何查看用户私人对话、饮食照片或身体数据的入口。你与教练的对话内容、语音/摄像头实时伴练画面以及长期记忆仅限你本人访问。"
          : "No. Backend administrators have zero access to your private Coach chats, meal photos, or body metrics in the Admin Console. Your coaching conversations, live camera/voice sessions, and memories are strictly isolated to your account.",
      }),
      el("div", { class: "pdpa-boundary-grid" }, [
        el("div", { class: "pdpa-boundary-col is-private" }, [
          el("div", { class: "pdpa-boundary-head" }, [
            icon("check-circle"),
            el("strong", {
              text: isZh ? "绝对私密（管理员永远不可见）" : "Strictly Private (Never visible to admins)",
            }),
          ]),
          el("ul", { class: "pdpa-boundary-list" }, [
            el("li", { text: isZh ? "与 AI 教练的所有文字/语音聊天记录与教练记忆" : "All AI Coach text/voice chat messages & coach memories" }),
            el("li", { text: isZh ? "三餐饮食照片、营养分析与卡路里详情" : "Meal photos, nutrition breakdowns & calorie logs" }),
            el("li", { text: isZh ? "体重、围度、个人健身目标与排期计划" : "Body weight, measurements, personal goals & workout plans" }),
            el("li", { text: isZh ? "实时动作指导的摄像头画面（仅在本地浏览器处理关键点）" : "Live camera form-check video (pose landmarks run locally in your browser)" }),
          ]),
        ]),
        el("div", { class: "pdpa-boundary-col is-ops" }, [
          el("div", { class: "pdpa-boundary-head" }, [
            icon("privacy-tip"),
            el("strong", {
              text: isZh ? "可选的运行诊断（由下方开关控制）" : "Optional Diagnostics (Controlled below)",
            }),
          ]),
          el("ul", { class: "pdpa-boundary-list" }, [
            el("li", { text: isZh ? "页面访问频次与功能点击统计（如打开了哪个标签页）" : "High-level screen views & feature clicks (e.g. which tab was opened)" }),
            el("li", { text: isZh ? "AI 响应耗时与工具调用次数（不含对话正文）" : "AI response latency & tool call counts (never message content)" }),
            el("li", { text: isZh ? "内测在线活跃状态（用于评估服务器负载）" : "Active beta presence indicator (used for server capacity monitoring)" }),
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
              text: isZh ? "共享使用情况与运行诊断数据" : "Share Usage & Operational Diagnostics Data",
            }),
            statusBadge,
          ]),
          el("p", {
            class: "pdpa-toggle-desc",
            text: isZh
              ? "遵循个人数据保护法（PDPA 第 13–16 条「知情同意与随时撤回权」），你可以自由关闭此开关。关闭后不会影响 AI 教练的任何功能，同时系统会立即停止采集诊断事件，并从后台清空你过往的在线与访问统计记录。"
              : "In accordance with PDPA (Sections 13–16 Consent & Withdrawal of Consent), you can turn this off at any time without affecting any AI Coach features. Turning it off immediately stops telemetry collection and purges your historical usage and presence records from the Admin Console.",
          }),
        ]),
        el("label", { class: "pdpa-switch", for: "pdpa-share-usage-toggle", "aria-label": isZh ? "切换是否共享使用数据" : "Toggle usage data sharing" }, [
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
            }, [icon("download"), el("span", { text: isZh ? "导出我的全部数据 (JSON)" : "Export My Data (JSON)" })])
          : null,
        el("a", {
          class: "btn btn-secondary btn-sm",
          href: "/privacy",
          target: "_blank",
          rel: "noopener",
        }, [icon("open-in-new"), el("span", { text: isZh ? "查看完整隐私政策" : "Full Privacy Policy" })]),
        onDelete
          ? el("button", {
              type: "button",
              class: "btn btn-secondary btn-sm pdpa-del-btn",
              onclick: () => { modal.close(); onDelete(); },
            }, [icon("delete-forever"), el("span", { text: isZh ? "注销并删除账户" : "Delete Account" })])
          : null,
      ].filter(Boolean)),
      el("button", {
        type: "button",
        class: "btn btn-primary",
        onclick: () => modal.close(),
      }, [isZh ? "完成" : "Done"]),
    ]),
  ]);

  const modal = openModal({
    title: isZh ? "隐私保护与数据共享设置 (PDPA)" : "Privacy & Data Controls (PDPA)",
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
