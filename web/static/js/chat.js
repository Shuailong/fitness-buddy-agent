// Coach chat: messages, activity chips, structured cards, SSE streaming,
// photo attachments, suggestion chips and the composer.
import { $, el, icon, humanize, renderMarkdown } from "./util.js";
import { api, postJson, getJson, readEventStream } from "./api.js";
import { state, actions } from "./state.js";
import { mealLoggedCard, confirmationCard } from "./cards.js";
import { suggestionChips } from "./logic.js";

const messagesEl = () => $("messages");
let chipRow = null;
let receivedCoachText = false;

function scrollToBottom() {
  const m = messagesEl();
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

function coachRow(children, { avatar = true, indent = false } = {}) {
  return el("div", { class: `row from-coach${avatar ? "" : " no-avatar"}${indent ? " indent" : ""}` }, [
    avatar ? el("span", { class: "bot-avatar", "aria-hidden": "true" }, [icon("smart-toy", { fill: true })]) : el("span", { class: "bot-avatar spacer", "aria-hidden": "true" }),
    el("div", { class: "row-body" }, children),
  ]);
}

export function addUserMessage(text, imageUrl, hadImage) {
  const children = [];
  if (imageUrl) children.push(el("img", { class: "attached", src: imageUrl, alt: "Your photo" }));
  else if (hadImage) children.push(el("span", { class: "photo-tag" }, [icon("image"), "Photo"]));
  if (text) children.push(el("p", { text }));
  messagesEl().append(el("div", { class: "row from-user" }, [el("div", { class: "bubble bubble-user" }, children)]));
  chipRow = null;
  scrollToBottom();
}

function addCoachMessage(text, author) {
  const body = [];
  if (author && !["fitness_coach", "coach"].includes(author)) body.push(el("span", { class: "author", text: humanize(author) }));
  body.push(el("div", { class: "bubble bubble-coach md", html: renderMarkdown(text) }));
  messagesEl().append(coachRow(body));
  chipRow = null;
  receivedCoachText = true;
  scrollToBottom();
}

export function addError(message) {
  messagesEl().append(el("div", { class: "row system" }, [el("p", { class: "msg-error", role: "alert" }, [icon("warning"), message])]));
  scrollToBottom();
}

function addDecision(confirmed, title) {
  messagesEl().append(el("div", { class: "row system" }, [
    el("p", { class: `decision ${confirmed ? "yes" : "no"}` }, [icon(confirmed ? "check-circle" : "undo"), `${confirmed ? "Approved" : "Declined"}: ${title}`]),
  ]));
}

function addActivityChip(label) {
  const clean = String(label).replace(/\.\.\.$/, "");
  if (!chipRow) {
    chipRow = el("div", { class: "chip-row", "aria-label": "Coach activity" });
    messagesEl().append(coachRow([chipRow], { avatar: false, indent: true }));
  }
  if (![...chipRow.children].some((c) => c.dataset.label === clean)) {
    chipRow.append(el("span", { class: "activity-chip", "data-label": clean }, [icon("check-circle"), clean]));
  }
  $("activity-label").textContent = label;
  scrollToBottom();
}

function addCard(node) {
  messagesEl().append(coachRow([node], { avatar: false }));
  chipRow = null;
  scrollToBottom();
}

function addMealCard(card) {
  addCard(mealLoggedCard(card, { prefill: (t) => prefillComposer(t), send: (t) => sendChat(t) }));
}

function addConfirmationCard(card) {
  if (document.querySelector(`[data-call-id="${CSS.escape(String(card.call_id))}"]`)) return;
  const node = confirmationCard(card, async (confirmed, { lock }) => {
    if (state.streaming) return;
    lock(confirmed);
    await streamRequest("/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: card.call_id, confirmed }),
    });
    if (!confirmed) $("message-input").focus();
  });
  addCard(node);
}

function setStreaming(on) {
  state.streaming = on;
  $("activity").hidden = !on;
  $("send-btn").disabled = on;
  $("new-chat-btn").disabled = on;
  for (const b of document.querySelectorAll(".suggestions button")) b.disabled = on;
  if (on) $("activity-label").textContent = "Coach is thinking...";
  else chipRow = null;
}

function handleEvent(ev) {
  switch (ev.type) {
    case "text": addCoachMessage(ev.text, ev.author); break;
    case "activity": addActivityChip(ev.label); break;
    case "confirmation": addConfirmationCard(ev); receivedCoachText = true; break;
    case "card": if (ev.kind === "meal_logged") addMealCard(ev); break;
    case "error": addError(ev.message || "Something went wrong."); break;
    default: break;
  }
}

async function streamRequest(path, options) {
  setStreaming(true);
  receivedCoachText = false;
  try {
    const res = await api(path, options);
    await readEventStream(res, handleEvent);
  } catch (err) {
    addError(err.message || "Connection lost. Please try again.");
  } finally {
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
  if (photoBlob) form.append("image", photoBlob, "photo.jpg");
  if (!hidden) addUserMessage(text, photoBlob ? URL.createObjectURL(photoBlob) : null);
  await streamRequest("/api/chat", { method: "POST", body: form });
  return true;
}

/** Opens (or resumes) the conversation and renders its history. Returns the session info. */
export async function openSession({ fresh = false } = {}) {
  messagesEl().replaceChildren();
  chipRow = null;
  const session = await (await postJson("/api/session", { new: fresh })).json();
  if (session.is_new) {
    renderIntro();
    return session;
  }
  const history = await getJson("/api/history");
  for (const m of history.messages) {
    if (m.role === "user") addUserMessage(m.text, null, m.has_image);
    else if (m.role === "coach") addCoachMessage(m.text, m.author);
    else if (m.role === "decision") addDecision(m.confirmed, m.title);
    else if (m.role === "card" && m.kind === "meal_logged") addMealCard(m);
  }
  for (const card of history.pending_confirmations) addConfirmationCard(card);
  if (!history.messages.length && !history.pending_confirmations.length) renderIntro();
  scrollToBottom();
  return session;
}

function renderIntro() {
  messagesEl().append(el("p", { class: "day-divider", text: `Today · ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}` }));
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
  const chips = suggestionChips(dashboard);
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
      img.onerror = () => reject(new Error("Could not read that image."));
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
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process that image."))), "image/jpeg", quality));
}

async function onPhotoSelected(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    const blob = await downscale(file);
    if (blob.size > state.config.max_image_bytes) throw new Error("That photo is too large.");
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
