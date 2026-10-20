// Offline experience: connection banner, last-synced chat snapshot, and an
// outbox for text messages typed without a connection (sent automatically
// when the connection returns). Everything here lives in this browser only
// and is cleared on sign-out.
import { $, el, icon } from "./util.js";
import { t } from "./i18n.js";

const SNAPSHOT_KEY = "fb.chat_snapshot_v1";
const OUTBOX_KEY = "fb.outbox_v1";
const SNAPSHOT_MAX = 60;
const OUTBOX_MAX = 20;

let onlineHandlers = [];
let backTimer = null;

export const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* quota / private mode */ }
}

// ------------------------------------------------------------ banner
function banner() {
  let node = $("offline-banner");
  if (!node) {
    node = el("div", { id: "offline-banner", class: "offline-banner", role: "status", "aria-live": "polite", hidden: true });
    document.body.append(node);
  }
  return node;
}

function renderBanner(mode) {
  const node = banner();
  clearTimeout(backTimer);
  if (mode === "online") {
    node.hidden = true;
    return;
  }
  node.className = `offline-banner is-${mode}`;
  node.replaceChildren(
    icon(mode === "offline" ? "cloud" : "check-circle"),
    el("span", { text: mode === "offline" ? t("offline.banner") : t("offline.back") }),
  );
  node.hidden = false;
  if (mode === "back") backTimer = setTimeout(() => { node.hidden = true; }, 2500);
}

/** Watches the connection; `onOnline` runs (once per reconnect) when it comes back. */
export function initOffline() {
  const sync = (back) => {
    document.body.classList.toggle("is-offline", isOffline());
    renderBanner(isOffline() ? "offline" : back ? "back" : "online");
  };
  window.addEventListener("offline", () => sync(false));
  window.addEventListener("online", () => {
    sync(true);
    for (const fn of onlineHandlers) {
      try { fn(); } catch (_) { /* keep going */ }
    }
  });
  sync(false);
}

export function onBackOnline(fn) {
  onlineHandlers.push(fn);
  return () => { onlineHandlers = onlineHandlers.filter((f) => f !== fn); };
}

// ------------------------------------------------------------ chat snapshot
/** Stores the latest conversation (text only, no photos) for offline viewing. */
export function saveChatSnapshot(owner, messages) {
  if (!owner) return;
  const slim = (messages || [])
    .filter((m) => (m.role === "user" || m.role === "coach") && (m.text || m.has_image))
    .slice(-SNAPSHOT_MAX)
    .map((m) => ({ role: m.role, text: m.text || "", author: m.author || null, persona: m.persona || null, voice: Boolean(m.voice), has_image: Boolean(m.has_image) }));
  write(SNAPSHOT_KEY, { owner, ts: Date.now(), messages: slim });
}

/** Appends one live message to the snapshot (keeps it current between reloads). */
export function appendChatSnapshot(owner, message) {
  if (!owner) return;
  const snap = read(SNAPSHOT_KEY, null);
  const messages = snap && snap.owner === owner ? snap.messages : [];
  saveChatSnapshot(owner, [...messages, message]);
}

export function loadChatSnapshot(owner) {
  const snap = read(SNAPSHOT_KEY, null);
  return snap && snap.owner === owner ? snap : null;
}

// ------------------------------------------------------------ outbox
export function outbox(owner) {
  const box = read(OUTBOX_KEY, null);
  return box && box.owner === owner ? box.items : [];
}

export function queueMessage(owner, text) {
  const items = [...outbox(owner), { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, ts: Date.now() }].slice(-OUTBOX_MAX);
  write(OUTBOX_KEY, { owner, items });
  return items[items.length - 1];
}

export function dropQueued(owner, id) {
  write(OUTBOX_KEY, { owner, items: outbox(owner).filter((m) => m.id !== id) });
}

/** Removes everything this module stored (sign-out / account deletion). */
export function clearOfflineData() {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
    localStorage.removeItem(OUTBOX_KEY);
  } catch (_) { /* ignore */ }
}
