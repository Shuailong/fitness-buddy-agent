// Coach chat: messages, live progress card, structured cards, SSE streaming,
// photo attachments, suggestion chips and the composer.
import { $, el, icon, humanize, renderMarkdown } from "./util.js";
import { api, postJson, getJson, readEventStream } from "./api.js";
import { state, actions } from "./state.js";
import { mealLoggedCard, confirmationCard } from "./cards.js";
import { suggestionChips, confirmationTitle } from "./logic.js";
import { t, getLang, dateFull } from "./i18n.js";
import { TurnProgress } from "./progress.js";

const messagesEl = () => $("messages");
let receivedCoachText = false;
// The in-flight turn: { progress: TurnProgress, row, skeleton } or null.
let turn = null;

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
  messagesEl().append(el("div", { class: "row from-user" }, [el("div", { class: "bubble bubble-user" }, children)]));
  scrollToBottom();
}

function addCoachMessage(text, author) {
  const body = [];
  if (author && !["fitness_coach", "coach"].includes(author)) {
    const key = `author.${author}`;
    const label = t(key);
    body.push(el("span", { class: "author", text: label === key ? humanize(author) : label }));
  }
  body.push(el("div", { class: "bubble bubble-coach md", html: renderMarkdown(text) }));
  appendMessage(coachRow(body));
  receivedCoachText = true;
  scrollToBottom();
}

export function addError(message) {
  appendMessage(el("div", { class: "row system" }, [el("p", { class: "msg-error", role: "alert" }, [icon("warning"), message])]));
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

function addCard(node) {
  const row = coachRow([node], { avatar: false });
  appendMessage(row);
  scrollToBottom();
  return row;
}

function addMealCard(card) {
  const node = mealLoggedCard(card, { prefill: (text) => prefillComposer(text), send: (text) => sendChat(text) });
  // Replace the optimistic skeleton in place when this turn showed one.
  if (turn && turn.skeleton && turn.skeleton.isConnected) {
    turn.skeleton.replaceWith(coachRow([node], { avatar: false }));
    turn.skeleton = null;
    scrollToBottom();
    return;
  }
  addCard(node);
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

function finishTurn({ error = false } = {}) {
  if (!turn) return;
  if (!turn.progress.finish({ error })) turn.row.remove();
  if (turn.skeleton) turn.skeleton.remove();
  turn = null;
}

function addConfirmationCard(card) {
  if (document.querySelector(`[data-call-id="${CSS.escape(String(card.call_id))}"]`)) return;
  const node = confirmationCard(card, async (confirmed, { lock }) => {
    if (state.streaming) return;
    lock(confirmed);
    await streamRequest("/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: card.call_id, confirmed, lang: getLang() }),
    });
    if (!confirmed) $("message-input").focus();
  });
  addCard(node);
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
}

function handleEvent(ev) {
  switch (ev.type) {
    case "text": addCoachMessage(ev.text, ev.author); break;
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

async function streamRequest(path, options, { photo = false } = {}) {
  setStreaming(true);
  receivedCoachText = false;
  startTurn({ photo });
  let failed = false;
  try {
    const res = await api(path, options);
    await readEventStream(res, (ev) => {
      if (ev.type === "error") failed = true;
      handleEvent(ev);
    });
  } catch (err) {
    failed = true;
    addError(err.message || t("error.connection"));
  } finally {
    finishTurn({ error: failed });
    setStreaming(false);
    if (receivedCoachText) actions.markUnread();
    actions.refreshDashboard();
  }
}

/** Sends a chat turn (text and/or a photo). Hidden turns don't render a bubble. */
export async function sendChat(text, photoBlob = null, { hidden = false } = {}) {
  if (state.streaming) return false;
  if (state.sessionReady) await state.sessionReady;
  state.pendingGreeting = false;
  const form = new FormData();
  form.append("text", text);
  form.append("lang", getLang());
  if (photoBlob) form.append("image", photoBlob, "photo.jpg");
  if (!hidden) addUserMessage(text, photoBlob ? URL.createObjectURL(photoBlob) : null);
  await streamRequest("/api/chat", { method: "POST", body: form }, { photo: Boolean(photoBlob) });
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
    else if (m.role === "coach") addCoachMessage(m.text, m.author);
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
  row.replaceChildren(...chips.map((c) => el("button", {
    type: "button", class: "suggestion", disabled: state.streaming,
    onclick: () => (c.send ? sendChat(c.send) : prefillComposer(c.prefill)),
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
