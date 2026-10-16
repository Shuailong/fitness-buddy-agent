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

const messagesEl = () => $("messages");
let receivedCoachText = false;
// The in-flight turn: { progress: TurnProgress, row, skeleton } or null.
let turn = null;
// event_id of the latest coach reply (for the daily feedback prompt).
let lastCoachEventId = null;
// Rate limits (HTTP 429): epoch ms until which sending / photos are blocked.
const limits = { send: 0, sendScope: null, photo: 0 };
let limitTimer = null;

function scrollToBottom() {
  const m = messagesEl();
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

/**
 * Adds a message row. While a turn is live, the progress card stays the last
 * element, so new bubbles/cards are inserted right before it.
 */
function appendMessage(node) {
  if (turn && !turn.progress.finished && turn.row.isConnected) turn.row.before(node);
  else messagesEl().append(node);
}

function coachRow(children, { avatar = true, indent = false } = {}) {
  return el("div", { class: `row from-coach${avatar ? "" : " no-avatar"}${indent ? " indent" : ""}` }, [
    avatar ? el("span", { class: "bot-avatar", "aria-hidden": "true" }, [icon("smart-toy", { fill: true })]) : el("span", { class: "bot-avatar spacer", "aria-hidden": "true" }),
    el("div", { class: "row-body" }, children),
  ]);
}

export function addUserMessage(text, imageUrl, hadImage) {
  const children = [];
  if (imageUrl) children.push(el("img", { class: "attached", src: imageUrl, alt: t("coach.yourPhoto") }));
  else if (hadImage) children.push(el("span", { class: "photo-tag" }, [icon("image"), t("coach.photo")]));
  if (text) children.push(el("p", { text }));
  const row = el("div", { class: "row from-user" }, [el("div", { class: "bubble bubble-user" }, children)]);
  messagesEl().append(row);
  scrollToBottom();
  return row;
}

function addCoachMessage(text, author, eventId = null) {
  const body = [];
  if (author && !["fitness_coach", "coach"].includes(author)) {
    const key = `author.${author}`;
    const label = t(key);
    body.push(el("span", { class: "author", text: label === key ? humanize(author) : label }));
  }
  body.push(el("div", { class: "bubble bubble-coach md", html: renderMarkdown(text) }));
  body.push(feedbackThumbs({ eventId }));
  appendMessage(coachRow(body));
  lastCoachEventId = eventId;
  receivedCoachText = true;
  scrollToBottom();
}

export function addError(message, { cls = "" } = {}) {
  appendMessage(el("div", { class: `row system ${cls}`.trim() }, [el("p", { class: "msg-error", role: "alert" }, [icon("warning"), message])]));
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

function finishTurn({ error = false } = {}) {
  if (!turn) return;
  if (!turn.progress.finish({ error })) turn.row.remove();
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
  addCard(node, card.kind === "replace_training_plan" ? [cardThumbs(card.event_id, "plan_card")] : []);
  return node;
}

function setStreaming(on) {
  state.streaming = on;
  document.body.classList.toggle("is-streaming", on);
  // The textarea stays usable; only submitting is blocked while a turn runs.
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
  for (const label of document.querySelectorAll(".composer-row label.icon-btn")) {
    const key = (label.dataset.i18nAttr || "").split(":")[1];
    label.querySelector("input").disabled = photoLeft > 0;
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
  if (text && !input.value.trim()) { input.value = text; autosize(input); }
  if (photoBlob && !state.photo) {
    state.photo = { blob: photoBlob, url: URL.createObjectURL(photoBlob) };
    $("photo-preview-img").src = state.photo.url;
    $("photo-preview").hidden = false;
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case "text": addCoachMessage(ev.text, ev.author, ev.event_id || null); break;
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
    case "error": addError(ev.message || t("error.generic")); break;
    default: break;
  }
}

async function streamRequest(path, options, { photo = false, onRateLimited = null } = {}) {
  setStreaming(true);
  receivedCoachText = false;
  lastCoachEventId = null;
  startTurn({ photo });
  let failed = false;
  let limited = null;
  try {
    const res = await api(path, options);
    await readEventStream(res, (ev) => {
      if (ev.type === "error") failed = true;
      handleEvent(ev);
    });
  } catch (err) {
    // 429s arrive before any SSE, so nothing was rendered for this turn yet.
    if (isRateLimited(err)) limited = err;
    else {
      failed = true;
      addError(err.message || t("error.connection"));
    }
  } finally {
    if (limited) discardTurn();
    else finishTurn({ error: failed });
    setStreaming(false);
    if (limited) {
      if (onRateLimited) onRateLimited(limited);
      startLimit(limited);
    } else if (receivedCoachText) {
      actions.markUnread();
      const prompt = failed ? null : dailyPromptAfterTurn(lastCoachEventId);
      if (prompt) { messagesEl().append(prompt); scrollToBottom(); }
    }
    actions.refreshDashboard();
  }
}

/** Sends a chat turn (text and/or a photo). Hidden turns don't render a bubble. */
export async function sendChat(text, photoBlob = null, { hidden = false } = {}) {
  if (state.streaming) return false;
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
  if (photoBlob) form.append("image", photoBlob, "photo.jpg");
  const userRow = hidden ? null : addUserMessage(text, photoBlob ? URL.createObjectURL(photoBlob) : null);
  await streamRequest("/api/chat", { method: "POST", body: form }, {
    photo: Boolean(photoBlob),
    onRateLimited: (err) => {
      if (userRow) userRow.remove();
      if (!hidden) restoreComposer(text, err.scope === "photos_per_day" ? null : photoBlob);
    },
  });
  return true;
}

/** Opens (or resumes) the conversation and renders its history. Returns the session info. */
export async function openSession({ fresh = false } = {}) {
  messagesEl().replaceChildren();
  const session = await (await postJson("/api/session", { new: fresh })).json();
  if (session.is_new) {
    renderIntro();
    return session;
  }
  const history = await getJson("/api/history");
  for (const m of history.messages) {
    if (m.role === "user") addUserMessage(m.text, null, m.has_image);
    else if (m.role === "coach") addCoachMessage(m.text, m.author, m.event_id || null);
    else if (m.role === "decision") addDecision(m);
    else if (m.role === "card" && m.kind === "meal_logged") addMealCard(m);
  }
  for (const card of history.pending_confirmations) addConfirmationCard(card);
  if (!history.messages.length && !history.pending_confirmations.length) renderIntro();
  scrollToBottom();
  return session;
}

function renderIntro() {
  messagesEl().append(el("p", { class: "day-divider", text: t("coach.today", { date: dateFull(new Date()) }) }));
}

// ------------------------------------------------------------- composer
export function prefillComposer(text) {
  const input = $("message-input");
  input.value = text;
  autosize(input);
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
    $("message-input").focus();
  } catch (err) {
    addError(err.message);
  }
}

function clearPhoto() {
  if (state.photo) URL.revokeObjectURL(state.photo.url);
  state.photo = null;
  $("photo-preview").hidden = true;
  $("photo-preview-img").removeAttribute("src");
}

export function pickPhoto(kind = "camera") {
  if (photoBlocked()) { showLimitError("photos_per_day"); return; }
  $(kind === "gallery" ? "gallery-input" : "camera-input").click();
}

export function initChat() {
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
    await sendChat(text, photo);
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
}
