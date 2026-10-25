// Coach chat: messages, live progress card, structured cards, SSE streaming,
// photo attachments, suggestion chips and the composer.
import { $, el, icon, humanize, renderMarkdown } from "./util.js";
import { api, postJson, getJson, readEventStream, isRateLimited } from "./api.js";
import { state, actions } from "./state.js";
import { mealLoggedCard, confirmationCard } from "./cards.js";
import { suggestionChips, confirmationTitle } from "./logic.js";
import { t, getLang, dateFull, duration } from "./i18n.js";
import { TurnProgress } from "./progress.js";
import { feedbackThumbs, dailyPromptAfterTurn } from "./feedback.js";
import { track } from "./telemetry.js";
import { openPhotoLightbox, showToast } from "./modal.js";
import { isOffline, saveChatSnapshot, appendChatSnapshot, loadChatSnapshot, outbox, queueMessage, dropQueued } from "./offline.js";
import { startRecording, voiceSupported, releaseMicrophone, warmMicrophone, scheduleMicRelease } from "./voice.js";
import { coachAvatar, getPersona, getPersonaId, onPersonaChange, openPersonaSelectorModal, speakCoachText, stopCoachSpeech, unlockCoachAudio } from "./personas.js";

// While older history is rendered off-screen, message builders write here.
let renderTarget = null;
const messagesEl = () => renderTarget || $("messages");
// Continuous timeline: earlier conversations load on scroll-up, one at a time.
const timeline = { oldestStartedAt: null, hasMore: false, loading: false, observer: null };
let receivedCoachText = false;
// The in-flight turn: { progress: TurnProgress, row, skeleton } or null.
let turn = null;
// event_id of the latest coach reply (for the daily feedback prompt).
let lastCoachEventId = null;
let activeMsgTtsBtn = null;
// Rate limits (HTTP 429): epoch ms until which sending / photos are blocked.
const limits = { send: 0, sendScope: null, photo: 0 };
let limitTimer = null;

// Follow new messages only while the reader is at the bottom; when they've
// scrolled up to read, show a "Latest" button instead of yanking them down.
let stickToBottom = true;
let hasUnseen = false;

function updateJumpButton() {
  const btn = $("jump-latest");
  if (!btn) return;
  btn.hidden = stickToBottom;
  btn.classList.toggle("has-new", hasUnseen);
  if (!stickToBottom) {
    const coach = $("coach-panel");
    const composer = $("composer");
    const suggestions = $("suggestions");
    const offset = (composer ? composer.offsetHeight : 0) + (suggestions && suggestions.offsetParent ? suggestions.offsetHeight : 0);
    if (coach) coach.style.setProperty("--jump-bottom", `${offset + 12}px`);
  }
}

/** Smoothly scrolls the conversation to the newest message. */
export function scrollChatToLatest({ smooth = true } = {}) {
  const m = messagesEl();
  hasUnseen = false;
  stickToBottom = true;
  updateJumpButton();
  requestAnimationFrame(() => m.scrollTo({ top: m.scrollHeight, behavior: smooth ? "smooth" : "auto" }));
}

function initJumpToLatest() {
  const m = messagesEl();
  m.addEventListener("scroll", () => {
    const near = m.scrollHeight - m.scrollTop - m.clientHeight < 120;
    if (near && hasUnseen) hasUnseen = false;
    if (near !== stickToBottom || near) {
      stickToBottom = near;
      updateJumpButton();
    }
  }, { passive: true });
  $("jump-latest").addEventListener("click", () => scrollChatToLatest());
}

function scrollToBottom(force = false) {
  if (renderTarget) return;
  const m = messagesEl();
  if (force || stickToBottom) {
    if (force) stickToBottom = true;
    requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
  } else {
    hasUnseen = true;
  }
  updateJumpButton();
}

/**
 * Adds a message row. While a turn is live, the progress card stays the last
 * element, so new bubbles/cards are inserted right before it.
 */
function appendMessage(node) {
  if (renderTarget) { renderTarget.append(node); return; }
  if (turn && !turn.progress.finished && turn.row.isConnected) turn.row.before(node);
  else messagesEl().append(node);
}

function coachRow(children, { avatar = true, indent = false, personaId = getPersonaId() } = {}) {
  const p = getPersona(personaId, getLang());
  return el("div", { class: `row from-coach${avatar ? "" : " no-avatar"}${indent ? " indent" : ""}`, "data-persona": p.id }, [
    avatar
      ? coachAvatar(p.id)
      : el("span", { class: "bot-avatar spacer", "aria-hidden": "true" }),
    el("div", { class: "row-body" }, children),
  ]);
}

export function addUserMessage(text, imageUrl, hadImage, { voice = false } = {}) {
  const children = [];
  if (voice) {
    children.push(el("span", { class: "voice-tag" }, [icon("mic"), t("chat.voice")]));
  }
  if (imageUrl) {
    children.push(
      el("img", {
        class: "attached is-zoomable",
        src: imageUrl,
        alt: t("coach.yourPhoto"),
        title: t("mealDetail.photoHint"),
        onclick: () => openPhotoLightbox(imageUrl, text || t("coach.yourPhoto")),
      }),
    );
  } else if (hadImage) {
    children.push(el("span", { class: "photo-tag" }, [icon("image"), t("coach.photo")]));
  }
  if (text) children.push(el("p", { text }));
  const row = el("div", { class: "row from-user" }, [el("div", { class: "bubble bubble-user" }, children)]);
  row.dataset.text = text || "";
  if (voice) row.dataset.voice = "1";
  messagesEl().append(row);
  refreshEditAffordance();
  scrollToBottom(true);
  return row;
}

// ------------------------------------------------------------- edit & resend
// Like ChatGPT: the latest text message can be edited and sent again; the old
// version and the replies to it stay visible, dimmed, as "previous version".
let editing = null; // { row, text }

function lastEditableUserRow() {
  const rows = [...messagesEl().querySelectorAll(".row.from-user")].filter(
    (r) => !r.classList.contains("is-superseded") && !r.classList.contains("is-queued"),
  );
  const last = rows[rows.length - 1];
  return last && last.dataset.text && !last.dataset.voice ? last : null;
}

function refreshEditAffordance() {
  if (renderTarget) return;
  for (const b of messagesEl().querySelectorAll(".msg-edit-btn")) b.remove();
  const row = lastEditableUserRow();
  if (!row) return;
  row.append(el("button", {
    type: "button",
    class: "msg-edit-btn",
    title: t("chat.edit"),
    "aria-label": t("chat.edit"),
    onclick: () => startEditing(row),
  }, [icon("edit"), el("span", { text: t("chat.edit") })]));
}

function editBanner() {
  let banner = $("edit-banner");
  if (!banner) {
    banner = el("div", { id: "edit-banner", class: "edit-banner", hidden: true }, [
      icon("edit"),
      el("span", { class: "edit-banner-text", text: t("chat.editing") }),
      el("button", { type: "button", class: "edit-banner-cancel", onclick: () => stopEditing({ clear: true }) }, [t("chat.cancelEdit")]),
    ]);
    $("composer").prepend(banner);
  }
  return banner;
}

function startEditing(row) {
  if (state.streaming) return;
  editing = { row, text: row.dataset.text };
  const input = $("message-input");
  input.value = editing.text;
  autosize(input);
  updateComposerActions();
  editBanner().hidden = false;
  row.classList.add("is-editing");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function stopEditing({ clear = false } = {}) {
  if (editing && editing.row) editing.row.classList.remove("is-editing");
  editing = null;
  const banner = $("edit-banner");
  if (banner) banner.hidden = true;
  if (clear) {
    const input = $("message-input");
    input.value = "";
    autosize(input);
    updateComposerActions();
  }
}

/** Dims a user message and everything after it as an older version. */
function supersedeFrom(row) {
  if (!row) return;
  row.classList.add("is-superseded");
  if (!row.querySelector(".superseded-tag")) {
    row.querySelector(".bubble").prepend(el("span", { class: "superseded-tag", text: t("chat.previousVersion") }));
  }
  for (let n = row.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.classList.contains("row") && !n.classList.contains("day-divider")) n.classList.add("is-superseded");
  }
}

function resetTtsBtn(btn) {
  if (!btn) return;
  const isZh = getLang() === "zh";
  btn.classList.remove("is-loading", "is-playing");
  btn.replaceChildren(icon("volume-up"), el("span", { text: t("chat.listen") }));
}

/**
 * Renders a coach reply. ``personaId`` is the coach who actually wrote it
 * (history keeps the original coach after a switch); defaults to the current one.
 */
function addCoachMessage(text, author, eventId = null, personaId = null) {
  const body = [];
  const isZh = getLang() === "zh";
  const p = getPersona(personaId || getPersonaId(), getLang());
  const personaLabel = p.copy.shortName;
  if (author && !["fitness_coach", "coach"].includes(author)) {
    const key = `author.${author}`;
    const label = t(key);
    body.push(el("span", { class: "author", text: `${personaLabel} · ${label === key ? humanize(author) : label}` }));
  } else {
    body.push(el("span", { class: "author", text: personaLabel }));
  }
  body.push(el("div", { class: "bubble bubble-coach md", html: renderMarkdown(text) }));

  const ttsBtn = el("button", {
    type: "button",
    class: "msg-tts-btn",
    title: t("chat.readAloud"),
    onclick: async () => {
      const zhNow = getLang() === "zh";
      if (activeMsgTtsBtn === ttsBtn) {
        activeMsgTtsBtn = null;
        stopCoachSpeech();
        resetTtsBtn(ttsBtn);
        return;
      }
      if (activeMsgTtsBtn) {
        resetTtsBtn(activeMsgTtsBtn);
      }
      activeMsgTtsBtn = ttsBtn;
      ttsBtn.classList.add("is-loading");
      ttsBtn.replaceChildren(
        el("span", { class: "pc-spinner", "aria-hidden": "true" }),
        el("span", { text: t("chat.ttsLoading") }),
      );
      unlockCoachAudio();
      // Read aloud in the coach selected now (not whoever wrote the message).
      await speakCoachText(text, {
        personaId: getPersonaId(),
        lang: getLang(),
        onStart: () => {
          if (activeMsgTtsBtn !== ttsBtn) return;
          ttsBtn.classList.remove("is-loading");
          ttsBtn.classList.add("is-playing");
          ttsBtn.replaceChildren(
            icon("pause"),
            el("span", { text: t("chat.stop") }),
          );
        },
        onEnd: () => {
          if (activeMsgTtsBtn === ttsBtn) {
            activeMsgTtsBtn = null;
          }
          resetTtsBtn(ttsBtn);
        },
      });
    },
  }, [icon("volume-up"), el("span", { text: t("chat.listen") })]);

  const footRow = el("div", { class: "coach-msg-foot" }, [
    feedbackThumbs({ eventId }),
    ttsBtn,
  ]);
  body.push(footRow);
  appendMessage(coachRow(body, { personaId: p.id }));
  lastCoachEventId = eventId;
  receivedCoachText = true;
  scrollToBottom();
}

export function addError(message, { cls = "", retry = null } = {}) {
  const row = el("div", { class: `row system ${cls}`.trim() });
  const children = [icon("warning"), el("span", { text: message })];
  if (retry) {
    children.push(el("button", {
      type: "button",
      class: "msg-retry-btn",
      onclick: () => {
        if (state.streaming) return;
        row.remove();
        retry();
      },
    }, [icon("refresh"), t("chat.retry")]));
  }
  row.append(el("p", { class: "msg-error", role: "alert" }, children));
  appendMessage(row);
  scrollToBottom();
}

function addDecision(m) {
  const title = String(m.kind ? confirmationTitle(m.kind, { replaces: m.replaces, serverTitle: m.title }, getLang()) : m.title).replace(/[?？]\s*$/, "");
  appendMessage(el("div", { class: "row system" }, [
    el("p", { class: `decision ${m.confirmed ? "yes" : "no"}` }, [icon(m.confirmed ? "check-circle" : "undo"), t(m.confirmed ? "coach.approved" : "coach.declined", { title })]),
  ]));
}

function addActivity(label) {
  if (turn && turn.progress.addStep(label)) scrollToBottom();
}

function addCard(node, extra = []) {
  const row = coachRow([node, ...extra], { avatar: false });
  appendMessage(row);
  scrollToBottom();
  return row;
}

const cardThumbs = (eventId, tag) => feedbackThumbs({ eventId: eventId || null, tags: [tag], label: t("fb.rateCard") });

function addMealCard(card) {
  const node = mealLoggedCard(card, {
    prefill: (text) => { track("card_action", { kind: "meal_logged", action: "fix" }); prefillComposer(text); },
    send: (text) => { track("card_action", { kind: "meal_logged", action: "undo" }); sendChat(text); },
  });
  // Replace the optimistic skeleton in place when this turn showed one.
  if (turn && turn.skeleton && turn.skeleton.isConnected) {
    turn.skeleton.replaceWith(coachRow([node, cardThumbs(card.event_id, "meal_card")], { avatar: false }));
    turn.skeleton = null;
    scrollToBottom();
    return;
  }
  addCard(node, [cardThumbs(card.event_id, "meal_card")]);
}

/** Placeholder meal card shown right after a photo is sent. */
function mealSkeleton() {
  const row = () => el("li", {}, [el("span", { class: "sk sk-name" }), el("span", { class: "sk sk-kcal" })]);
  return el("article", { class: "chat-card meal-skeleton", "aria-busy": "true", "aria-label": t("card.analyzing") }, [
    el("div", { class: "card-head" }, [
      el("span", { class: "badge badge-ok" }, [el("span", { class: "pc-spinner", "aria-hidden": "true" }), t("card.analyzingBadge")]),
      el("h3", { class: "card-title", text: t("card.analyzing") }),
    ]),
    el("ul", { class: "item-rows", "aria-hidden": "true" }, [row(), row(), row()]),
    el("div", { class: "sk sk-totals", "aria-hidden": "true" }),
  ]);
}

function startTurn({ photo = false } = {}) {
  const progress = new TurnProgress();
  const row = coachRow([progress.node], { avatar: false, indent: true });
  row.classList.add("progress-row");
  const skeleton = photo ? coachRow([mealSkeleton()], { avatar: false }) : null;
  if (skeleton) messagesEl().append(skeleton);
  messagesEl().append(row);
  turn = { progress, row, skeleton };
  scrollToBottom();
}

/** Removes the live card without a summary (the request never started streaming). */
function discardTurn() {
  if (!turn) return;
  turn.progress.discard();
  turn.row.remove();
  if (turn.skeleton) turn.skeleton.remove();
  turn = null;
}

function finishTurn({ error = false, stopped = false } = {}) {
  if (!turn) return;
  if (!turn.progress.finish({ error, stopped })) turn.row.remove();
  if (turn.skeleton) turn.skeleton.remove();
  turn = null;
}

function addConfirmationCard(card) {
  if (document.querySelector(`[data-call-id="${CSS.escape(String(card.call_id))}"]`)) return;
  const node = confirmationCard(card, async (confirmed, { lock, unlock }) => {
    if (state.streaming) return;
    lock(confirmed);
    track("card_action", { kind: String(card.kind || "unknown"), action: confirmed ? "approve" : "decline" });
    let limited = false;
    await streamRequest("/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: card.call_id, confirmed, lang: getLang() }),
    }, { onRateLimited: () => { limited = true; unlock(); } });
    if (!confirmed && !limited) $("message-input").focus();
  });
  addCard(node, card.kind === "replace_training_plan" || card.kind === "update_plan_day" ? [cardThumbs(card.event_id, "plan_card")] : []);
  return node;
}

function stopButton() {
  let btn = $("stop-btn");
  if (!btn) {
    btn = el("button", {
      type: "button",
      id: "stop-btn",
      class: "send-btn stop-btn",
      hidden: true,
      title: t("chat.stopGenerating"),
      "aria-label": t("chat.stopGenerating"),
      onclick: () => stopTurn(),
    }, [el("span", { class: "stop-square", "aria-hidden": "true" })]);
    $("send-btn").after(btn);
  }
  return btn;
}

function setStreaming(on) {
  state.streaming = on;
  document.body.classList.toggle("is-streaming", on);
  // The textarea stays usable (type the next message); sending waits, and
  // the send button turns into Stop, like ChatGPT.
  stopButton().hidden = !on;
  updateComposerActions();
  $("send-btn").disabled = on;
  $("new-chat-btn").disabled = on;
  for (const b of document.querySelectorAll(".suggestions button")) b.disabled = on;
  actions.setBusy(on);
  applyLimits();
}

// ------------------------------------------------------------- rate limits
const sendBlocked = () => limits.send > Date.now();
const photoBlocked = () => limits.photo > Date.now();

function rateMessage(scope, seconds) {
  const time = duration(seconds);
  if (String(scope || "").startsWith("demo_")) return t("rate.demo");
  if (scope === "photos_per_day") return t("rate.photos", { time });
  if (scope === "messages_per_day") return t("rate.day", { time });
  return t("rate.minute", { time });
}

/** Shows the friendly inline error (replacing an older one) for the active limit. */
function showLimitError(scope) {
  const until = scope === "photos_per_day" ? limits.photo : limits.send;
  for (const old of messagesEl().querySelectorAll(".row.rate-limit")) old.remove();
  addError(rateMessage(scope, (until - Date.now()) / 1000), { cls: "rate-limit" });
}

/** Send button: aria-disabled (still focusable, countdown in the tooltip) until the limit ends. */
function applyLimits() {
  const now = Date.now();
  const sendLeft = (limits.send - now) / 1000;
  const photoLeft = (limits.photo - now) / 1000;
  const btn = $("send-btn");
  if (sendLeft > 0) {
    btn.setAttribute("aria-disabled", "true");
    btn.title = t("rate.wait", { time: duration(sendLeft) });
  } else {
    btn.removeAttribute("aria-disabled");
    btn.removeAttribute("title");
  }
  for (const label of document.querySelectorAll(".attach-tile")) {
    const key = (label.dataset.i18nAttr || "").split(":")[1];
    const fileInput = $(label.getAttribute("for"));
    if (fileInput) fileInput.disabled = photoLeft > 0;
    label.classList.toggle("is-disabled", photoLeft > 0);
    if (photoLeft > 0) label.title = t("rate.photoWait", { time: duration(photoLeft) });
    else if (key) label.title = t(key);
  }
  if (sendLeft <= 0 && photoLeft <= 0 && limitTimer) { clearInterval(limitTimer); limitTimer = null; }
}

function startLimit(err) {
  const until = Date.now() + Math.max(1, err.retryAfter || 30) * 1000;
  if (err.scope === "photos_per_day") limits.photo = until;
  else { limits.send = until; limits.sendScope = err.scope; }
  if (!limitTimer) limitTimer = setInterval(applyLimits, 1000);
  applyLimits();
  showLimitError(err.scope === "photos_per_day" ? "photos_per_day" : err.scope);
}

/** Puts a rate-limited message back into the composer so nothing is lost. */
function restoreComposer(text, photoBlob) {
  const input = $("message-input");
  if (text && !input.value.trim()) { input.value = text; autosize(input); updateComposerActions(); }
  if (photoBlob && !state.photo) {
    state.photo = { blob: photoBlob, url: URL.createObjectURL(photoBlob) };
    $("photo-preview-img").src = state.photo.url;
    $("photo-preview").hidden = false;
    updateComposerActions();
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case "text":
      addCoachMessage(ev.text, ev.author, ev.event_id || null);
      appendChatSnapshot(snapshotOwner(), { role: "coach", text: ev.text, author: ev.author, persona: getPersonaId() });
      break;
    case "activity": addActivity(ev.label); break;
    case "confirmation": {
      // Collapse first so the summary pill sits right above the approval card.
      if (turn) turn.progress.finish();
      const node = addConfirmationCard(ev);
      receivedCoachText = true;
      if (node) actions.onConfirmation(ev, node);
      break;
    }
    case "card": if (ev.kind === "meal_logged") addMealCard(ev); break;
    // An earlier reply finished in the background while this turn waited.
    case "resync": resyncAfterTurn = true; break;
    case "error": addError(ev.message || t("error.generic"), { retry: currentRetry }); break;
    case "stopped": break;
    default: break;
  }
}

let resyncAfterTurn = false;
let activeStream = null; // { controller, stopping }
let currentRetry = null; // re-sends the current request (error "Retry")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves once the page is visible and the device is online. */
function whenVisibleAndOnline() {
  if (!document.hidden && navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!document.hidden && navigator.onLine !== false) {
        document.removeEventListener("visibilitychange", check);
        window.removeEventListener("online", check);
        resolve();
      }
    };
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
  });
}

/** Reads one SSE response, counting frames so a resume continues after them. */
async function readTurnStream(res, counter) {
  const out = { finished: false, failed: false, stopped: false };
  await readEventStream(res, (ev) => {
    counter.seen += 1;
    if (ev.type === "error") out.failed = true;
    if (ev.type === "stopped") out.stopped = true;
    if (ev.type === "done") out.finished = true;
    handleEvent(ev);
  });
  return out;
}

/**
 * The connection dropped mid-reply (phone locked, app switched, flaky 5G) but
 * the server keeps generating: re-attach with /api/chat/resume and continue
 * in the same bubble (ChatGPT-style). Returns done | stopped | error | gone.
 */
async function resumeTurn(counter, controller) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (activeStream && activeStream.stopping) return "stopped";
    if (turn) turn.progress.setStatus(t("chat.reconnecting"), "cloud");
    await whenVisibleAndOnline();
    await sleep(attempt === 0 ? 300 : Math.min(8000, 1000 * 2 ** Math.min(attempt, 3)));
    try {
      const res = await api(`/api/chat/resume?after=${counter.seen}`, { signal: controller.signal });
      if (turn) turn.progress.setStatus(null);
      const r = await readTurnStream(res, counter);
      if (r.stopped) return "stopped";
      if (r.finished) return r.failed ? "error" : "done";
    } catch (err) {
      if (activeStream && activeStream.stopping) return "stopped";
      if (err.status === 404) return "gone";
      if (err.status && err.status < 500) return "gone";
    }
  }
  return "gone";
}

/** Stops the reply being generated (the Stop button). */
async function stopTurn() {
  if (!activeStream || activeStream.stopping) return;
  activeStream.stopping = true;
  track("chat_stop");
  const stream = activeStream;
  try { await postJson("/api/chat/stop", {}); } catch (_) { /* aborted below */ }
  // The server answers with "stopped"; abort the read if that doesn't arrive.
  setTimeout(() => { if (activeStream === stream) stream.controller.abort(); }, 2500);
}

/**
 * Runs one turn: POSTs (or, with ``resumeAfter``, re-attaches to a reply that
 * is already running) and renders the SSE events into a live turn.
 */
async function streamRequest(path, options, { photo = false, onRateLimited = null, onBusy = null, resumeAfter = null, retry = null } = {}) {
  setStreaming(true);
  receivedCoachText = false;
  lastCoachEventId = null;
  currentRetry = retry;
  startTurn({ photo });
  const controller = new AbortController();
  activeStream = { controller, stopping: false };
  const counter = { seen: resumeAfter || 0 };
  let failed = false;
  let limited = null;
  let outcome = null; // done | stopped | busy | gone | error
  try {
    try {
      const res = resumeAfter === null
        ? await api(path, { ...options, signal: controller.signal })
        : await api(`/api/chat/resume?after=${resumeAfter}`, { signal: controller.signal });
      const r = await readTurnStream(res, counter);
      failed = r.failed;
      outcome = r.stopped ? "stopped" : r.finished ? "done" : null;
    } catch (err) {
      if (activeStream.stopping) outcome = "stopped";
      else if (isRateLimited(err)) limited = err;
      else if (err.code === "turn_in_progress") outcome = "busy";
      else if (resumeAfter !== null && err.status === 404) outcome = "gone";
      else if (err.status) {
        failed = true;
        outcome = "error";
        addError(err.message || t("error.connection"), { retry });
      }
      // No HTTP status: the connection dropped; resume below.
    }
    if (!outcome && !limited) {
      outcome = await resumeTurn(counter, controller);
      if (outcome === "error") failed = true;
    }
  } finally {
    activeStream = null;
    currentRetry = null;
    if (limited || outcome === "busy") discardTurn();
    else finishTurn({ error: failed && outcome !== "stopped", stopped: outcome === "stopped" });
    setStreaming(false);
    if (limited) {
      if (onRateLimited) onRateLimited(limited);
      startLimit(limited);
    } else if (receivedCoachText && outcome !== "stopped") {
      actions.markUnread();
      const prompt = failed ? null : dailyPromptAfterTurn(lastCoachEventId);
      if (prompt) { messagesEl().append(prompt); scrollToBottom(); }
    }
    actions.refreshDashboard();
    if (outcome === "busy") {
      // A reply is still being generated (e.g. started on another tab or
      // before the app was reopened): show it instead of queueing this one.
      if (onBusy) onBusy();
      showToast(t("chat.stillReplying"), { iconName: "schedule" });
      openSession().catch(() => {});
    } else if (outcome === "gone" || resyncAfterTurn) {
      resyncAfterTurn = false;
      openSession().catch(() => {});
    }
  }
}

/** Sends a chat turn (text and/or a photo). Hidden turns don't render a bubble. */
export async function sendChat(text, photoBlob = null, { hidden = false, voiceRow = null, row = null, edit = null } = {}) {
  if (state.streaming) return false;
  if (isOffline() && !hidden) {
    // No connection: keep text in the outbox (sent when back online); photos
    // and voice need the server, so say so instead of losing them.
    if (photoBlob || voiceRow) {
      if (voiceRow) voiceRow.remove();
      restoreComposer(text, photoBlob);
      addError(t(photoBlob ? "offline.noPhoto" : "offline.noVoice"));
      return false;
    }
    if (!row) addQueuedMessage(queueMessage(snapshotOwner(), text));
    return false;
  }
  if (hidden && isOffline()) return false;
  if (sendBlocked() || (photoBlob && photoBlocked())) {
    if (!hidden) restoreComposer(text, photoBlocked() ? null : photoBlob);
    showLimitError(sendBlocked() ? limits.sendScope : "photos_per_day");
    return false;
  }
  if (state.sessionReady) await state.sessionReady;
  state.pendingGreeting = false;
  const form = new FormData();
  form.append("text", text);
  form.append("lang", getLang());
  if (!hidden) form.append("persona", getPersonaId());
  if (photoBlob) form.append("image", photoBlob, "photo.jpg");
  if (voiceRow) form.append("voice", "1");
  if (edit) {
    form.append("edited", "1");
    supersedeFrom(edit);
  }
  const userRow = hidden ? null : voiceRow || row || addUserMessage(text, photoBlob ? URL.createObjectURL(photoBlob) : null);
  if (!hidden) appendChatSnapshot(snapshotOwner(), { role: "user", text, has_image: Boolean(photoBlob), voice: Boolean(voiceRow) });
  await streamRequest("/api/chat", { method: "POST", body: form }, {
    photo: Boolean(photoBlob),
    retry: hidden ? null : () => sendChat(text, photoBlob, { row: userRow }),
    onRateLimited: (err) => {
      if (userRow) userRow.remove();
      if (!hidden) restoreComposer(text, err.scope === "photos_per_day" ? null : photoBlob);
    },
    onBusy: () => {
      if (userRow && !row && !voiceRow) userRow.remove();
      if (!hidden) restoreComposer(text, photoBlob);
    },
  });
  return true;
}

function sessionLoadingSkeleton() {
  const isZh = getLang() === "zh";
  return el("div", { class: "chat-boot-skeleton", role: "status", "aria-live": "polite" }, [
    el("div", { class: "loading-banner" }, [
      el("span", { class: "spinner", "aria-hidden": "true" }),
      el("span", { text: t("chat.connectingToYourAiCoach") }),
    ]),
    el("div", { class: "row from-coach", "aria-hidden": "true" }, [
      coachAvatar(getPersonaId()),
      el("div", { class: "row-body" }, [
        el("div", { class: "bubble bubble-coach chat-sk-bubble" }, [
          el("div", { class: "sk dsk-line-lg" }),
          el("div", { class: "sk dsk-line-md" }),
        ]),
      ]),
    ]),
  ]);
}

/** The local "conversation day" (ISO date): days roll over at 4 am, like the server. */
export function conversationDay(now = new Date()) {
  const d = new Date(now.getTime() - 4 * 3600 * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(day) {
  const [y, m, d] = String(day || "").split("-").map(Number);
  const date = y ? new Date(y, m - 1, d) : new Date();
  const today = conversationDay();
  const yesterday = conversationDay(new Date(Date.now() - 24 * 3600 * 1000));
  if (!day || day === today) return t("coach.today", { date: dateFull(date) });
  if (day === yesterday) return t("coach.yesterday", { date: dateFull(date) });
  return dateFull(date);
}

function dayDivider(day) {
  return el("p", { class: "day-divider", "data-day": day || conversationDay(), text: dayLabel(day) });
}

function renderHistoryMessages(messages) {
  for (const m of messages) {
    if (m.role === "user" && m.edited) {
      const prev = [...messagesEl().querySelectorAll(".row.from-user:not(.is-superseded)")].pop();
      supersedeFrom(prev);
    }
    if (m.role === "user") addUserMessage(m.text, m.image_url || null, m.has_image, { voice: Boolean(m.voice) });
    else if (m.role === "coach") addCoachMessage(m.text, m.author, m.event_id || null, m.persona || null);
    else if (m.role === "decision") addDecision(m);
    else if (m.role === "card" && m.kind === "meal_logged") addMealCard(m);
  }
}

function historyLoader() {
  const isZh = getLang() === "zh";
  const btn = el("button", {
    type: "button",
    class: "history-loader-btn",
    onclick: () => loadOlderHistory(),
  }, [icon("schedule"), el("span", { text: t("chat.earlierMessages") })]);
  return el("div", { class: "row system history-loader", id: "history-loader" }, [btn]);
}

function setLoaderState(stateName) {
  const loader = $("history-loader");
  if (!loader) return;
  const isZh = getLang() === "zh";
  const btn = loader.querySelector("button");
  if (stateName === "end") {
    loader.replaceChildren(el("p", { class: "history-end muted small", text: t("chat.thisIsTheBeginningOf") }));
    if (timeline.observer) timeline.observer.disconnect();
  } else if (btn) {
    btn.disabled = stateName === "loading";
    btn.lastElementChild.textContent = stateName === "loading"
      ? (t("chat.loading"))
      : (t("chat.earlierMessages"));
  }
}

/** Prepends the previous conversation (one session) above what is shown, keeping the scroll position. */
export async function loadOlderHistory() {
  if (timeline.loading || !timeline.hasMore || !timeline.oldestStartedAt) return;
  timeline.loading = true;
  setLoaderState("loading");
  try {
    const data = await getJson(`/api/history/older?before=${encodeURIComponent(timeline.oldestStartedAt)}`);
    if (!data.session_id || !data.messages.length) {
      timeline.hasMore = false;
      setLoaderState("end");
      return;
    }
    const m = $("messages");
    const loader = $("history-loader");
    const chunk = el("div");
    const saved = { lastCoachEventId, receivedCoachText };
    renderTarget = chunk;
    try {
      chunk.append(dayDivider(data.day));
      renderHistoryMessages(data.messages);
    } finally {
      renderTarget = null;
      ({ lastCoachEventId, receivedCoachText } = saved);
    }
    // One divider per day: drop the next chunk's divider when it is the same day.
    const next = loader ? loader.nextElementSibling : m.firstElementChild;
    if (next && next.classList.contains("day-divider") && next.dataset.day === data.day) next.remove();
    const fromBottom = m.scrollHeight - m.scrollTop;
    const nodes = [...chunk.childNodes];
    if (loader) loader.after(...nodes); else m.prepend(...nodes);
    m.scrollTop = m.scrollHeight - fromBottom;
    timeline.oldestStartedAt = data.started_at;
    timeline.hasMore = Boolean(data.has_more);
    track("history_older", { has_more: timeline.hasMore });
    setLoaderState(timeline.hasMore ? "idle" : "end");
  } catch (err) {
    setLoaderState("idle");
    addError(err.message);
  } finally {
    timeline.loading = false;
  }
}

function startTimeline(session) {
  timeline.oldestStartedAt = session.started_at || Date.now() / 1000;
  timeline.hasMore = true;
  const m = messagesEl();
  m.prepend(historyLoader());
  if (timeline.observer) timeline.observer.disconnect();
  if ("IntersectionObserver" in window) {
    // Auto-load when the user scrolls up to the top of the chat.
    timeline.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && m.scrollHeight > m.clientHeight) loadOlderHistory();
    }, { root: m, rootMargin: "120px 0px 0px 0px" });
    timeline.observer.observe($("history-loader"));
  }
}

/** Opens (or resumes) today's conversation and renders it below earlier days. Returns the session info. */
export async function openSession({ fresh = false } = {}) {
  const bootSk = sessionLoadingSkeleton();
  messagesEl().replaceChildren(bootSk);
  try {
    const session = await (await postJson("/api/session", { new: fresh, include_history: true })).json();
    bootSk.remove();
    state.sessionDay = session.day || conversationDay();
    messagesEl().append(dayDivider(session.day));
    startTimeline(session);
    if (session.is_new) return session;
    const history = session.history || await getJson("/api/history");
    renderHistoryMessages(history.messages);
    saveChatSnapshot(snapshotOwner(), history.messages);
    for (const card of history.pending_confirmations) addConfirmationCard(card);
    renderQueuedMessages();
    refreshEditAffordance();
    scrollToBottom(true);
    if (session.active_turn && !state.streaming) {
      // The coach is still replying (app reopened mid-reply): follow it live.
      streamRequest(null, null, {
        photo: session.active_turn.intent === "photo",
        resumeAfter: session.active_turn.after || 0,
      });
    }
    return session;
  } catch (err) {
    bootSk.remove();
    throw err;
  }
}

// ------------------------------------------------------------- offline
const snapshotOwner = () => (state.me && state.me.email) || null;

/** A user bubble waiting in the outbox (sent automatically when back online). */
function addQueuedMessage(item) {
  const row = addUserMessage(item.text, null, false);
  row.dataset.outboxId = item.id;
  row.classList.add("is-queued");
  const body = row.querySelector(".row-body") || row;
  body.append(el("span", { class: "queued-tag" }, [icon("schedule"), t("offline.queued")]));
  scrollToBottom();
  return row;
}

function renderQueuedMessages() {
  for (const item of outbox(snapshotOwner())) {
    if (!document.querySelector(`[data-outbox-id="${CSS.escape(item.id)}"]`)) addQueuedMessage(item);
  }
}

/** Offline start: the last-synced conversation plus queued messages, read-only until reconnect. */
export function renderOfflineChat() {
  const snap = loadChatSnapshot(snapshotOwner());
  messagesEl().replaceChildren(dayDivider(state.sessionDay || conversationDay()));
  if (snap) renderHistoryMessages(snap.messages);
  messagesEl().append(el("div", { class: "row system" }, [el("p", { class: "offline-note" }, [icon("cloud"), t("offline.chatNote")])]));
  renderQueuedMessages();
  scrollToBottom(true);
}

/** Sends queued messages one by one (oldest first) once the connection is back. */
export async function flushOutbox() {
  const owner = snapshotOwner();
  for (const item of outbox(owner)) {
    if (isOffline() || state.streaming) return;
    const row = document.querySelector(`[data-outbox-id="${CSS.escape(item.id)}"]`) || addQueuedMessage(item);
    row.classList.remove("is-queued");
    const tag = row.querySelector(".queued-tag");
    if (tag) tag.remove();
    dropQueued(owner, item.id);
    await sendChat(item.text, null, { row });
  }
}

// ------------------------------------------------------------- composer
export function prefillComposer(text) {
  const input = $("message-input");
  input.value = text;
  autosize(input);
  if (!$("hold-to-talk").hidden) setVoiceMode(false);
  updateComposerActions();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

function autosize(input) {
  input.style.height = "";
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

export function renderSuggestions(dashboard) {
  const row = $("suggestions");
  const chips = suggestionChips(dashboard, new Date(), getLang());
  row.replaceChildren(...chips.map((c, index) => el("button", {
    type: "button", class: "suggestion", disabled: state.streaming,
    onclick: () => {
      track("suggestion_chip", { index });
      return c.send ? sendChat(c.send) : prefillComposer(c.prefill);
    },
  }, [c.label])));
}

// ------------------------------------------------------------- photos
async function downscale(file, maxSide = 1280, quality = 0.85) {
  let source;
  let width;
  let height;
  if (window.createImageBitmap) {
    try {
      source = await createImageBitmap(file, { imageOrientation: "from-image" });
      width = source.width; height = source.height;
    } catch (_) { source = null; }
  }
  if (!source) {
    source = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t("error.photoRead")));
      img.src = URL.createObjectURL(file);
    });
    width = source.naturalWidth; height = source.naturalHeight;
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t("error.photoProcess")))), "image/jpeg", quality));
}

async function onPhotoSelected(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const blob = await downscale(file);
    if (blob.size > state.config.max_image_bytes) throw new Error(t("error.photoTooLarge"));
    clearPhoto();
    state.photo = { blob, url: URL.createObjectURL(blob) };
    $("photo-preview-img").src = state.photo.url;
    $("photo-preview").hidden = false;
    updateComposerActions();
    $("message-input").focus();
  } catch (err) {
    addError(err.message);
  }
}

function clearPhoto() {
  if (state.photo) URL.revokeObjectURL(state.photo.url);
  state.photo = null;
  $("photo-preview").hidden = true;
  updateComposerActions();
  $("photo-preview-img").removeAttribute("src");
}

export function pickPhoto(kind = "camera") {
  if (photoBlocked()) { showLimitError("photos_per_day"); return; }
  $(kind === "gallery" ? "gallery-input" : "camera-input").click();
}

export function syncCoachPersonaHeader() {
  const head = document.querySelector(".coach-head");
  if (!head) return;
  const isZh = getLang() === "zh";
  const p = getPersona(getPersonaId(), getLang());

  // Replace the header avatar with the illustrated SVG portrait
  const oldAvatar = head.querySelector(".bot-avatar, .coach-svg-avatar");
  const newAvatar = coachAvatar(p.id, { size: "lg", online: true });
  if (oldAvatar) oldAvatar.replaceWith(newAvatar);
  else head.prepend(newAvatar);

  // Remove any legacy .coach-persona-slot that caused horizontal squeezing
  const oldSlot = head.querySelector(".coach-persona-slot");
  if (oldSlot) oldSlot.remove();

  // Build a clean, non-wrapping title + compact pills row inside .coach-titles
  const titlesWrap = head.querySelector(".coach-titles");
  if (titlesWrap) {
    const switchBtn = el(
      "button",
      {
        type: "button",
        class: "coach-switch-chip",
        title: t("chat.switchAiCoachPersonaOr"),
        onclick: () => openPersonaSelectorModal({ onSwitched: () => syncCoachPersonaHeader() }),
      },
      [
        icon("swap-horiz"),
        el("span", { text: t("chat.switch") }),
      ]
    );
    const privacyBtn = el(
      "button",
      {
        type: "button",
        class: "coach-privacy-pill",
        title: t("chat.pdpaProtectedCoachChatIs"),
        onclick: () => {
          if (actions.openPrivacy) actions.openPrivacy();
        },
      },
      [
        icon("shield"),
        el("span", { text: t("chat.private") }),
      ]
    );
    titlesWrap.replaceChildren(
      el("div", { class: "coach-title-row" }, [
        el("h2", { id: "coach-title", text: p.copy.shortName }),
        switchBtn,
        privacyBtn,
      ]),
      el("p", { class: "coach-subtitle-line", text: p.copy.genderTag })
    );
  }

}

/**
 * Switching coach keeps the same conversation and memories; past replies keep
 * the coach who wrote them, and a divider marks where the new coach takes over.
 */
function markPersonaSwitch(id, { previous, fromServer } = {}) {
  if (!previous || previous === id) return;
  const m = messagesEl();
  if (!m || !m.querySelector(".row.from-coach, .row.from-user")) return;
  const p = getPersona(id, getLang());
  const isZh = getLang() === "zh";
  m.append(el("div", { class: "row system" }, [
    el("p", { class: "persona-switch-divider" }, [
      coachAvatar(p.id, { size: "sm" }),
      el("span", {
        text: `${fromServer ? t("chat.syncedFromDevice") : ""}${t("chat.coachTakesOver", { name: p.copy.shortName })}`,
      }),
    ]),
  ]));
  scrollToBottom();
}

// ------------------------------------------------------------- voice messages
const VOICE_MODE_KEY = "fb.voice_mode";
const MAX_VOICE_S = 60;
const MIN_VOICE_S = 0.7;

function fmtSecs(s) {
  const n = Math.max(1, Math.round(s));
  return `${n}″`;
}

/** WeChat-style voice bubble: tap to play; transcript shown underneath. */
function addUserVoiceMessage({ url, duration }) {
  const isZh = getLang() === "zh";
  const width = Math.round(108 + Math.min(duration, MAX_VOICE_S) * 3.2);
  const audio = new Audio(url);
  const playIcon = el("span", { class: "voice-play", "aria-hidden": "true" }, [icon("play-arrow")]);
  const bars = el("span", { class: "voice-bars", "aria-hidden": "true" }, Array.from({ length: 5 }, () => el("i")));
  const bubble = el("button", {
    type: "button",
    class: "bubble bubble-user voice-bubble",
    style: { width: `${width}px` },
    "aria-label": t("chat.playVoiceMessageP0Seconds", { p0: Math.round(duration) }),
    onclick: () => {
      if (audio.paused) { audio.currentTime = 0; audio.play().catch(() => {}); } else { audio.pause(); }
    },
  }, [el("span", { class: "voice-dur", text: fmtSecs(duration) }), bars, playIcon]);
  audio.addEventListener("play", () => bubble.classList.add("is-playing"));
  for (const ev of ["pause", "ended"]) audio.addEventListener(ev, () => bubble.classList.remove("is-playing"));
  const transcript = el("p", { class: "voice-transcript is-pending" }, [
    el("span", { class: "pc-spinner", "aria-hidden": "true" }),
    el("span", { text: t("chat.transcribing") }),
  ]);
  const row = el("div", { class: "row from-user voice-row" }, [el("div", { class: "voice-stack" }, [bubble, transcript])]);
  messagesEl().append(row);
  scrollToBottom();
  return {
    row,
    setTranscript(text) {
      transcript.classList.remove("is-pending");
      transcript.replaceChildren(el("span", { text }));
      scrollToBottom();
    },
    confirm(text, { onSend, onEdit }) {
      transcript.classList.remove("is-pending");
      transcript.classList.add("is-partial");
      const sendBtn = el("button", { type: "button", class: "btn btn-primary btn-sm" }, [t("chat.send")]);
      const editBtn = el("button", { type: "button", class: "btn btn-secondary btn-sm" }, [t("chat.edit")]);
      transcript.replaceChildren(
        el("span", { class: "voice-partial-note" }, [icon("warning"), t("chat.someWordsWereUnclearConfirm")]),
        el("span", { class: "voice-partial-text", text }),
        el("span", { class: "voice-partial-actions" }, [editBtn, sendBtn]),
      );
      sendBtn.addEventListener("click", () => {
        transcript.classList.remove("is-partial");
        transcript.replaceChildren(el("span", { text }));
        onSend(text);
      });
      editBtn.addEventListener("click", () => onEdit(text));
      scrollToBottom();
    },
    fail(message) {
      transcript.classList.remove("is-pending");
      transcript.classList.add("is-error");
      transcript.replaceChildren(icon("warning"), el("span", { text: message }));
    },
  };
}

async function transcribeBlob(blob) {
  const form = new FormData();
  form.append("audio", blob, "voice.wav");
  form.append("lang", getLang());
  const res = await api("/api/transcribe", { method: "POST", body: form });
  const data = await res.json();
  const text = String(data.text || "").trim();
  const status = text ? (data.status === "partial" ? "partial" : "ok") : "no_speech";
  return { text, status };
}

async function sendVoiceMessage(blob, duration) {
  const isZh = getLang() === "zh";
  const vm = addUserVoiceMessage({ url: URL.createObjectURL(blob), duration });
  let text = "";
  let status = "no_speech";
  try {
    ({ text, status } = await transcribeBlob(blob));
  } catch (err) {
    vm.fail(isRateLimited(err) ? err.message : (t("chat.couldnTTranscribeTryAgain")));
    return;
  }
  if (!text) {
    vm.fail(t("chat.didnTCatchThatPlease"));
    return;
  }
  if (status === "partial") {
    // Not fully intelligible: never send a guess - let the user confirm or fix it.
    vm.confirm(text, {
      onSend: async (finalText) => {
        track("voice_message", { mode: "send_confirmed", seconds: Math.round(duration) });
        await sendChat(finalText, null, { voiceRow: vm.row });
      },
      onEdit: (finalText) => {
        vm.row.remove();
        setVoiceMode(false);
        const input = $("message-input");
        input.value = finalText;
        autosize(input);
        updateComposerActions();
        input.focus();
      },
    });
    return;
  }
  vm.setTranscript(text);
  track("voice_message", { mode: "send", seconds: Math.round(duration) });
  await sendChat(text, null, { voiceRow: vm.row });
}

/**
 * iPhone (Safari and home-screen apps) asks for the microphone again on every
 * launch unless the site is set to "Allow". Explain that once, if we see the
 * permission back at "prompt" after it was granted before.
 */
async function maybeShowMicTip() {
  try {
    if (localStorage.getItem("fb.mic_granted") !== "1" || localStorage.getItem("fb.mic_tip_shown") === "1") return;
    if (!navigator.permissions || !navigator.permissions.query) return;
    const st = await navigator.permissions.query({ name: "microphone" });
    if (st.state !== "prompt") return;
    localStorage.setItem("fb.mic_tip_shown", "1");
    const isZh = getLang() === "zh";
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    const tip = ios
      ? (t("chat.tiredOfTheMicrophonePrompt"))
      : (t("chat.tiredOfTheMicrophonePrompt2"));
    addError(tip, { cls: "mic-tip" });
  } catch (_) { /* Permissions API unsupported */ }
}

/** WeChat-style trailing button: "Send" when there is something to send, otherwise "+". */
export function updateComposerActions() {
  const input = $("message-input");
  const voiceOn = !$("hold-to-talk").hidden;
  const hasContent = Boolean(input.value.trim()) || Boolean(state.photo);
  $("send-btn").hidden = state.streaming || voiceOn || !hasContent;
  $("attach-toggle").hidden = !state.streaming && !$("send-btn").hidden;
}

function setAttachTray(open) {
  const tray = $("attach-tray");
  tray.hidden = !open;
  $("attach-toggle").setAttribute("aria-expanded", String(open));
  $("attach-toggle").classList.toggle("is-open", open);
  if (open) scrollToBottom();
}

/** Microphone permission without prompting ("granted" | "prompt" | "denied" | "unknown"). */
async function micPermission() {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return "unknown";
    return (await navigator.permissions.query({ name: "microphone" })).state;
  } catch (_) {
    return "unknown";
  }
}

function setVoiceMode(on, { restoring = false } = {}) {
  const input = $("message-input");
  const hold = $("hold-to-talk");
  const toggle = $("voice-toggle");
  hold.hidden = !on;
  input.hidden = on;
  setAttachTray(false);
  updateComposerActions();
  toggle.setAttribute("aria-pressed", String(on));
  toggle.replaceChildren(icon(on ? "keyboard" : "mic"));
  const isZh = getLang() === "zh";
  toggle.title = on ? (t("chat.switchToKeyboard")) : (t("chat.voiceMessage"));
  toggle.setAttribute("aria-label", toggle.title);
  try { localStorage.setItem(VOICE_MODE_KEY, on ? "1" : "0"); } catch (_) { /* ignore */ }
  if (on && restoring) {
    // Reopening the app in voice mode must not trigger a permission prompt
    // (iPhone home-screen apps forget the microphone grant on every launch).
    // Warm up only if the browser already allows it; otherwise the first
    // press of "Hold to talk" asks, once per app session.
    micPermission().then((state) => { if (state === "granted") warmMicrophone().catch(() => {}); });
  } else if (on) {
    // Ask for the microphone now (on this tap), not in the middle of a hold.
    maybeShowMicTip();
    warmMicrophone().catch(() => {});
  } else {
    input.focus();
  }
}

function voiceOverlay() {
  const isZh = getLang() === "zh";
  const bars = el("div", { class: "vo-bars", "aria-hidden": "true" }, Array.from({ length: 22 }, () => el("i")));
  const time = el("span", { class: "vo-time", text: "" });
  const cancelZone = el("div", { class: "vo-zone vo-cancel" }, [
    el("span", { class: "vo-zone-label", text: t("chat.releaseToCancel") }),
    el("span", { class: "vo-zone-ic", "aria-hidden": "true" }, [icon("close")]),
  ]);
  const textZone = el("div", { class: "vo-zone vo-text" }, [
    el("span", { class: "vo-zone-label", text: t("chat.releaseForText") }),
    el("span", { class: "vo-zone-ic vo-zone-ic-text", "aria-hidden": "true", text: t("chat.aa") }),
  ]);
  const arcLabel = el("span", { class: "vo-arc-label" });
  const node = el("div", { class: "voice-overlay", role: "dialog", "aria-live": "polite" }, [
    el("div", { class: "vo-center" }, [el("div", { class: "vo-bubble" }, [bars]), time]),
    el("div", { class: "vo-zones" }, [cancelZone, textZone]),
    el("div", { class: "vo-arc" }, [el("span", { class: "vo-arc-ic", "aria-hidden": "true" }, [icon("mic")]), arcLabel]),
  ]);
  const levels = new Array(22).fill(0.1);
  const labels = {
    starting: t("chat.openingMicrophone"),
    send: t("chat.releaseToSend"),
    cancel: t("chat.releaseToCancel"),
    text: t("chat.releaseForText"),
    working: t("chat.transcribing2"),
  };
  return {
    node,
    setZone(zone) {
      node.dataset.zone = zone;
      arcLabel.textContent = labels[zone] || "";
    },
    level(v) {
      levels.shift(); levels.push(Math.max(0.1, v));
      [...bars.children].forEach((b, i) => { b.style.transform = `scaleY(${levels[i]})`; });
    },
    time(secs) {
      const left = MAX_VOICE_S - secs;
      time.textContent = left <= 10 ? (t("chat.sendingInP0S", { p0: Math.ceil(left) })) : `${Math.floor(secs)}″`;
    },
    zoneAt(x, y) {
      const hit = (z) => { const rc = z.querySelector(".vo-zone-ic").getBoundingClientRect(); return x >= rc.left - 28 && x <= rc.right + 28 && y >= rc.top - 60 && y <= rc.bottom + 24; };
      if (hit(cancelZone)) return "cancel";
      if (hit(textZone)) return "text";
      return "send";
    },
  };
}

function initVoice() {
  const toggle = $("voice-toggle");
  const hold = $("hold-to-talk");
  const attach = $("attach-toggle");
  attach.addEventListener("click", () => setAttachTray($("attach-tray").hidden));
  $("message-input").addEventListener("input", updateComposerActions);
  $("message-input").addEventListener("focus", () => setAttachTray(false));
  for (const id of ["camera-input", "gallery-input"]) $(id).addEventListener("change", () => { setAttachTray(false); setTimeout(updateComposerActions, 0); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseMicrophone(); });
  updateComposerActions();
  if (!voiceSupported()) { toggle.hidden = true; return; }
  let saved = "0";
  try { saved = localStorage.getItem(VOICE_MODE_KEY) || "0"; } catch (_) { /* ignore */ }
  if (saved === "1") setVoiceMode(true, { restoring: true });
  toggle.addEventListener("click", () => setVoiceMode(hold.hidden));

  let rec = null;
  let overlay = null;
  let pressing = false;
  let zone = "send";
  let timer = null;

  const close = () => {
    clearInterval(timer);
    timer = null;
    hold.classList.remove("is-pressed");
    if (overlay) { overlay.node.remove(); overlay = null; }
  };

  async function finish(finalZone) {
    pressing = false;
    scheduleMicRelease();
    const r = rec;
    rec = null;
    if (!r) { close(); return; }
    if (finalZone === "cancel") { r.cancel(); close(); return; }
    const { blob, duration } = await r.stop();
    const isZh = getLang() === "zh";
    if (duration < MIN_VOICE_S) {
      close();
      addError(t("chat.tooShortHoldWhileYou"), { cls: "voice-short" });
      setTimeout(() => { for (const n of messagesEl().querySelectorAll(".voice-short")) n.remove(); }, 2500);
      return;
    }
    if (finalZone === "text") {
      overlay.setZone("working");
      try {
        const { text, status } = await transcribeBlob(blob);
        close();
        if (!text) { addError(t("chat.didnTCatchThatPlease")); return; }
        if (status === "partial") {
          addError(t("chat.someWordsWereUnclearAnd"), { cls: "voice-short" });
          setTimeout(() => { for (const n of messagesEl().querySelectorAll(".voice-short")) n.remove(); }, 4000);
        }
        track("voice_message", { mode: "to_text", seconds: Math.round(duration) });
        setVoiceMode(false);
        const input = $("message-input");
        input.value = input.value ? `${input.value} ${text}` : text;
        autosize(input);
        updateComposerActions();
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (err) {
        close();
        addError(isRateLimited(err) ? err.message : (t("chat.couldnTTranscribePleaseTry")));
      }
      return;
    }
    close();
    sendVoiceMessage(blob, duration);
  }

  hold.addEventListener("contextmenu", (e) => e.preventDefault());
  // iOS: keep the page from scrolling or rubber-banding while sliding the finger.
  hold.addEventListener("touchmove", (e) => { if (pressing) e.preventDefault(); }, { passive: false });
  hold.addEventListener("pointerdown", async (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const isZh = getLang() === "zh";
    if (state.streaming) { addError(t("chat.yourCoachIsStillReplying")); return; }
    if (isOffline()) { addError(t("offline.noVoice")); return; }
    if (sendBlocked()) { showLimitError(limits.sendScope); return; }
    try { hold.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    pressing = true;
    zone = "send";
    hold.classList.add("is-pressed");
    overlay = voiceOverlay();
    overlay.setZone("starting");
    document.body.append(overlay.node);
    stopCoachSpeech();
    const asked = performance.now();
    try {
      rec = await startRecording({ onLevel: (v) => overlay && overlay.level(v) });
    } catch (err) {
      close();
      pressing = false;
      addError(t("chat.microphoneUnavailableAllowMicrophoneAccess"));
      return;
    }
    if (!pressing) {
      // Released while the permission prompt was open: don't send a stray clip.
      rec.cancel(); rec = null; close();
      if (performance.now() - asked > 600) addError(t("chat.microphoneReadyPressAndHold"));
      return;
    }
    if (navigator.vibrate) navigator.vibrate(15);
    overlay.setZone(zone);
    timer = setInterval(() => {
      if (!rec || !overlay) return;
      const secs = (performance.now() - rec.startedAt) / 1000;
      overlay.time(secs);
      if (secs >= MAX_VOICE_S) finish(zone === "cancel" ? "send" : zone);
    }, 200);
  });
  hold.addEventListener("pointermove", (e) => {
    if (!pressing || !overlay || !rec) return;
    const next = overlay.zoneAt(e.clientX, e.clientY);
    if (next !== zone) { zone = next; overlay.setZone(zone); if (navigator.vibrate) navigator.vibrate(8); }
  });
  hold.addEventListener("pointerup", () => { if (pressing) finish(zone); });
  hold.addEventListener("pointercancel", () => { if (pressing) finish("cancel"); });
}

export function initChat() {
  initJumpToLatest();
  syncCoachPersonaHeader();
  onPersonaChange((id, info) => {
    syncCoachPersonaHeader();
    markPersonaSwitch(id, info);
  });
  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.streaming) return;
    const input = $("message-input");
    const text = input.value.trim();
    const photo = state.photo ? state.photo.blob : null;
    if (!text && !photo) return;
    // Keep the typed text (and photo) while a rate limit is active.
    if (sendBlocked()) { showLimitError(limits.sendScope); return; }
    if (photo && photoBlocked()) { showLimitError("photos_per_day"); return; }
    input.value = "";
    input.style.height = "";
    clearPhoto();
    const edit = editing && text ? editing.row : null;
    stopEditing();
    await sendChat(text, photo, { edit });
  });
  $("message-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("message-input").addEventListener("input", (e) => autosize(e.target));
  $("camera-input").addEventListener("change", onPhotoSelected);
  $("gallery-input").addEventListener("change", onPhotoSelected);
  $("photo-remove").addEventListener("click", clearPhoto);
  initVoice();
}
