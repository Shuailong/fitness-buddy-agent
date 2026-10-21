// Settings > Reminders: Web Push opt-in (training-day and meal-logging nudges).
import { el, icon } from "./util.js";
import { t, getLang } from "./i18n.js";
import { postJson, getJson } from "./api.js";
import { state } from "./state.js";
import { isStandalone, detectPlatform } from "./pwa.js";
import { track } from "./telemetry.js";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function keyBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

function toggle(id, checked, onChange, label) {
  const input = el("input", { type: "checkbox", class: "pdpa-switch-input", id, checked: checked ? "checked" : null });
  input.addEventListener("change", () => onChange(input.checked, input));
  return el("label", { class: "pdpa-switch", for: id, "aria-label": label }, [input, el("span", { class: "pdpa-switch-slider" })]);
}

/** The Reminders card (renders its own state asynchronously). */
export function remindersCard({ showToast = null } = {}) {
  const body = el("div", { class: "reminders-body" }, [el("p", { class: "muted small", text: t("reminders.loading") })]);
  const cardNode = el("section", { class: "card settings-card", "aria-labelledby": "settings-reminders-heading" }, [
    el("h2", { id: "settings-reminders-heading", class: "settings-section-title", text: t("reminders.title") }),
    body,
  ]);
  const note = (text, extra = null) => body.replaceChildren(el("p", { class: "muted small reminders-note" }, [icon("notifications"), el("span", { text })]), extra);

  async function render() {
    if (state.me && state.me.is_demo) return note(t("reminders.demo"));
    const ios = detectPlatform().os === "ios";
    if (!supported()) {
      return ios && !isStandalone()
        ? note(t("reminders.iosInstall"), el("a", { class: "btn btn-secondary btn-sm", href: "/install" }, [icon("install-mobile"), t("reminders.installGuide")]))
        : note(t("reminders.unsupported"));
    }
    let config;
    try { config = await getJson("/api/push/config"); } catch (_) { return note(t("reminders.unavailable")); }
    if (!config.enabled) return note(t("reminders.unavailable"));
    if (Notification.permission === "denied") return note(t("reminders.denied"));
    const sub = await currentSubscription();
    let status = { subscribed: false, prefs: {} };
    if (sub) {
      try { status = await postJson("/api/push/status", { endpoint: sub.endpoint }).then((r) => r.json()); } catch (_) { /* offline */ }
    }
    const prefs = { training: true, meals: true, ...(status.prefs || {}) };

    const master = toggle("reminders-master", status.subscribed, async (on, input) => {
      input.disabled = true;
      try {
        if (on) await enable(config.public_key);
        else await disable();
        track("reminders", { action: on ? "on" : "off" });
      } catch (err) {
        input.checked = !on;
        if (showToast) showToast(err.message || t("reminders.failed"), { iconName: "warning" });
      } finally {
        input.disabled = false;
        render();
      }
    }, t("reminders.title"));

    const rows = [
      el("div", { class: "settings-pref-item" }, [
        el("div", { class: "settings-pref-copy" }, [el("strong", { text: t("reminders.enable") }), el("span", { class: "muted small", text: t("reminders.enableSub") })]),
        master,
      ]),
    ];
    if (status.subscribed) {
      const pref = (kind, title, sub) => el("div", { class: "settings-pref-item reminders-kind" }, [
        el("div", { class: "settings-pref-copy" }, [el("strong", { text: title }), el("span", { class: "muted small", text: sub })]),
        toggle(`reminders-${kind}`, prefs[kind], async (on) => {
          const s = await currentSubscription();
          if (s) await postJson("/api/push/prefs", { endpoint: s.endpoint, prefs: { [kind]: on } });
        }, title),
      ]);
      rows.push(
        pref("training", t("reminders.training"), t("reminders.trainingSub")),
        pref("meals", t("reminders.meals"), t("reminders.mealsSub")),
        el("button", {
          type: "button",
          class: "btn btn-secondary btn-sm reminders-test",
          onclick: async () => {
            try {
              const res = await postJson(`/api/push/test?lang=${getLang()}`, {}).then((r) => r.json());
              if (showToast) showToast(res.sent ? t("reminders.testSent") : t("reminders.failed"), { iconName: res.sent ? "check-circle" : "warning" });
            } catch (err) {
              if (showToast) showToast(err.message || t("reminders.failed"), { iconName: "warning" });
            }
          },
        }, [icon("notifications"), t("reminders.test")]),
      );
    }
    body.replaceChildren(el("div", { class: "settings-pref-grid" }, rows));
  }

  async function enable(publicKey) {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error(t("reminders.denied"));
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    const json = sub.toJSON();
    await postJson("/api/push/subscribe", {
      subscription: { endpoint: json.endpoint, keys: json.keys },
      lang: getLang(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    });
  }

  async function disable() {
    const sub = await currentSubscription();
    if (!sub) return;
    try { await postJson("/api/push/unsubscribe", { endpoint: sub.endpoint }); } catch (_) { /* best effort */ }
    await sub.unsubscribe();
  }

  render();
  return cardNode;
}

/** Sign-out: stop reminders on this device (best effort, never blocks sign-out). */
export async function unsubscribeThisDevice() {
  try {
    const sub = await currentSubscription();
    if (!sub) return;
    await Promise.race([postJson("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    await sub.unsubscribe();
  } catch (_) { /* ignore */ }
}
