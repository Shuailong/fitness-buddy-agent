// Coach Memory (Settings): durable facts the coach remembers across
// conversations and coach personas. Users can view, add, and delete them.
import { el, icon } from "./util.js";
import { api, getJson, postJson } from "./api.js";
import { getLang, t } from "./i18n.js";

const CAT_LABELS = {
  preference: { zh: "偏好", en: "Preference", icon: "favorite" },
  goal: { zh: "目标", en: "Goal", icon: "target" },
  schedule: { zh: "作息", en: "Schedule", icon: "schedule" },
  training: { zh: "训练", en: "Training", icon: "fitness-center" },
  nutrition: { zh: "饮食", en: "Nutrition", icon: "restaurant" },
  health: { zh: "健康", en: "Health", icon: "health-and-safety" },
  other: { zh: "其他", en: "Other", icon: "auto-awesome" },
};

function catLabel(cat, isZh) {
  const c = CAT_LABELS[cat] || CAT_LABELS.other;
  return isZh ? c.zh : c.en;
}

/** Renders the Coach Memory settings card; loads its list asynchronously. */
export function coachMemoryCard({ showToast = null } = {}) {
  const isZh = getLang() === "zh";
  const list = el("ul", { class: "memory-list", "aria-live": "polite" }, [
    el("li", { class: "memory-empty muted small", text: t("chat.loading") }),
  ]);
  const counter = el("span", { class: "pill pill-outline memory-count", text: "–" });
  const input = el("input", {
    type: "text",
    class: "text-input memory-input",
    maxlength: "240",
    placeholder: t("memory.eGNoCilantroCan"),
    "aria-label": t("memory.addAMemory"),
  });
  const catSelect = el("select", { class: "text-input memory-cat", "aria-label": t("memory.category") },
    Object.keys(CAT_LABELS).map((k) => el("option", { value: k, text: catLabel(k, isZh) })));
  catSelect.value = "preference";
  const clearBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm pdpa-del-btn", hidden: true }, [
    icon("delete-forever"), el("span", { text: t("memory.clearAll") }),
  ]);
  let maxItems = 40;

  function render(memories) {
    counter.textContent = `${memories.length}/${maxItems}`;
    clearBtn.hidden = memories.length === 0;
    if (!memories.length) {
      list.replaceChildren(el("li", {
        class: "memory-empty muted small",
        text: t("memory.nothingYetMentionPreferencesIn"),
      }));
      return;
    }
    list.replaceChildren(...memories.slice().reverse().map((m) => {
      const c = CAT_LABELS[m.category] || CAT_LABELS.other;
      const del = el("button", {
        type: "button",
        class: "icon-btn memory-del",
        title: t("memory.forgetThis"),
        "aria-label": t("memory.forgetP0", { p0: m.text }),
        onclick: async () => {
          del.disabled = true;
          try {
            await api(`/api/memories/${encodeURIComponent(m.memory_id)}`, { method: "DELETE" });
            await load();
          } catch (err) {
            del.disabled = false;
            if (showToast) showToast(err.message, { iconName: "warning" });
          }
        },
      }, [icon("close")]);
      return el("li", { class: "memory-item" }, [
        el("span", { class: "memory-cat-icon", "aria-hidden": "true" }, [icon(c.icon)]),
        el("div", { class: "memory-body" }, [
          el("p", { class: "memory-text", text: m.text }),
          el("span", {
            class: "muted small",
            text: `${catLabel(m.category, isZh)} · ${m.source === "user" ? (t("memory.addedByYou")) : (t("memory.savedByCoach"))} · ${String(m.updated_at || m.created_at || "").slice(0, 10)}`,
          }),
        ]),
        del,
      ]);
    }));
  }

  async function load() {
    try {
      const data = await getJson("/api/memories");
      maxItems = data.max || maxItems;
      render(data.memories || []);
    } catch (err) {
      list.replaceChildren(el("li", { class: "memory-empty msg-error", text: err.message }));
    }
  }

  const form = el("form", {
    class: "memory-add",
    onsubmit: async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      try {
        const res = await (await postJson("/api/memories", { text, category: catSelect.value })).json();
        input.value = "";
        if (showToast) {
          showToast(res.status === "duplicate"
            ? (t("memory.alreadyRemembered"))
            : (t("memory.savedEveryCoachWillUse")), { timeout: 3500 });
        }
        await load();
      } catch (err) {
        if (showToast) showToast(err.message, { iconName: "warning" });
      } finally {
        input.disabled = false;
        input.focus();
      }
    },
  }, [
    catSelect,
    input,
    el("button", { type: "submit", class: "btn btn-primary btn-sm" }, [icon("add"), el("span", { text: t("memory.add") })]),
  ]);

  clearBtn.addEventListener("click", async () => {
    const ok = window.confirm(t("memory.forgetEveryCoachMemoryEntry"));
    if (!ok) return;
    try {
      await api("/api/memories", { method: "DELETE" });
      await load();
    } catch (err) {
      if (showToast) showToast(err.message, { iconName: "warning" });
    }
  });

  const card = el("section", { class: "card settings-card", "aria-labelledby": "settings-memory-heading" }, [
    el("div", { class: "settings-card-head" }, [
      el("div", { class: "settings-card-title-group" }, [
        el("span", { class: "round-icon", "aria-hidden": "true" }, [icon("psychology")]),
        el("div", {}, [
          el("h2", { id: "settings-memory-heading", text: t("memory.coachMemory") }),
          el("p", {
            class: "muted small",
            text: t("memory.preferencesAndFactsYourCoach"),
          }),
        ]),
      ]),
      counter,
    ]),
    list,
    form,
    el("div", { class: "memory-foot" }, [clearBtn]),
  ]);
  load();
  return card;
}
