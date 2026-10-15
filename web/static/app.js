// Fitness Buddy web client: vanilla JS, no build step.
// Talks to the FastAPI backend in web/main.py (SSE over fetch for chat).
"use strict";

const state = {
  config: null,
  streaming: false,
  photo: null, // { blob, url }
  dashboardLoaded: false,
};

const $ = (id) => document.getElementById(id);

// --------------------------------------------------------------- helpers
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v; // only used with escaped/sanitized markup
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const fmt = (n, digits = 0) =>
  n === null || n === undefined || Number.isNaN(n) ? "–" : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });

const humanize = (s) => String(s).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  if (res.status === 401) {
    showSignIn();
    throw new Error("Sign in required.");
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status}).`;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* not JSON */ }
    throw new Error(detail);
  }
  return res;
}

// ------------------------------------------------------- simple markdown
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
}

function renderMarkdown(src) {
  const lines = escapeHtml(src.replace(/\r\n/g, "\n")).split("\n");
  const out = [];
  let para = [];
  let list = null; // { type: "ul"|"ol", items: [] }
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inlineMd).join("<br>")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join("")}</${list.type}>`); list = null; } };
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Tables: header row followed by a |---| separator row.
    if (isRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara(); flushList();
      const head = cells(line);
      const body = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) body.push(cells(lines[i++]));
      i--;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${inlineMd(h)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const heading = line.match(/^\s*#{1,6}\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (heading) { flushPara(); flushList(); out.push(`<h4>${inlineMd(heading[1])}</h4>`); }
    else if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((ul || ol)[1]);
    } else if (!line.trim()) { flushPara(); flushList(); }
    else if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += " " + line.trim(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join("");
}

// ------------------------------------------------------------- chat UI
const messagesEl = () => $("messages");

function scrollToBottom() {
  const m = messagesEl();
  requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
}

function addUserMessage(text, imageUrl, hadImage) {
  const children = [];
  if (imageUrl) children.push(el("img", { class: "attached", src: imageUrl, alt: "Your photo" }));
  else if (hadImage) children.push(el("span", { class: "photo-tag", text: "📷 Photo" }), text ? el("br") : null);
  if (text) children.push(text);
  messagesEl().append(el("div", { class: "msg user" }, children));
  scrollToBottom();
}

function addCoachMessage(text, author) {
  const node = el("div", { class: "msg coach" });
  if (author && author !== "fitness_coach") node.append(el("span", { class: "author", text: humanize(author) }));
  node.append(el("div", { html: renderMarkdown(text) }));
  messagesEl().append(node);
  scrollToBottom();
}

function addError(message) {
  messagesEl().append(el("div", { class: "msg error", role: "alert", text: message }));
  scrollToBottom();
}

function addDecision(confirmed, title) {
  messagesEl().append(el("div", { class: "msg decision", text: `${confirmed ? "✅ Confirmed" : "↩️ Rejected"}: ${title}` }));
}

let chipRow = null;
function addActivityChip(label) {
  if (!chipRow) {
    chipRow = el("div", { class: "chip-row" });
    messagesEl().append(chipRow);
  }
  const existing = [...chipRow.children].some((c) => c.textContent === label);
  if (!existing) chipRow.append(el("span", { class: "chip", text: label.replace(/\.\.\.$/, "") }));
  $("activity-label").textContent = label;
  scrollToBottom();
}

function renderDetails(value, depth = 0) {
  if (value === null || value === undefined) return document.createTextNode("–");
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== "object" || v === null)) return document.createTextNode(value.join(", "));
    return el("ul", { class: "kv" }, value.map((v, i) => el("li", {}, [el("span", { class: "k", text: `#${i + 1}` }), renderDetails(v, depth + 1)])));
  }
  if (typeof value === "object") {
    if (depth > 4) return document.createTextNode(JSON.stringify(value));
    return el("ul", { class: "kv" }, Object.entries(value).map(([k, v]) =>
      el("li", {}, [el("span", { class: "k", text: `${humanize(k)}:` }), renderDetails(v, depth + 1)])));
  }
  return document.createTextNode(String(value));
}

function addConfirmationCard(card) {
  if (document.querySelector(`[data-call-id="${CSS.escape(card.call_id)}"]`)) return;
  const confirmBtn = el("button", { class: "btn primary", type: "button", text: "Confirm" });
  const rejectBtn = el("button", { class: "btn secondary", type: "button", text: "Reject" });
  const hasDetails = card.details && Object.keys(card.details).length > 0;
  const node = el("div", { class: "confirm-card", "data-call-id": card.call_id }, [
    el("span", { class: "badge", text: "Needs your OK" }),
    el("h3", { text: card.title }),
    card.summary ? el("p", { class: "summary", text: card.summary }) : null,
    hasDetails ? el("details", {}, [el("summary", { text: "Details" }), renderDetails(card.details)]) : null,
    el("div", { class: "confirm-actions" }, [rejectBtn, confirmBtn]),
  ]);
  const decide = async (confirmed) => {
    if (state.streaming) return;
    confirmBtn.disabled = true;
    rejectBtn.disabled = true;
    node.append(el("div", { class: `decided ${confirmed ? "yes" : "no"}`, text: confirmed ? "✅ Confirmed" : "↩️ Rejected" }));
    await streamRequest("/api/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: card.call_id, confirmed }),
    });
  };
  confirmBtn.addEventListener("click", () => decide(true));
  rejectBtn.addEventListener("click", () => decide(false));
  messagesEl().append(node);
  scrollToBottom();
}

function setStreaming(on) {
  state.streaming = on;
  $("activity").hidden = !on;
  $("send-btn").disabled = on;
  $("new-chat-btn").disabled = on;
  if (on) $("activity-label").textContent = "Coach is thinking...";
  else chipRow = null;
}

function handleEvent(ev) {
  switch (ev.type) {
    case "text": addCoachMessage(ev.text, ev.author); chipRow = null; break;
    case "activity": addActivityChip(ev.label); break;
    case "confirmation": addConfirmationCard(ev); break;
    case "error": addError(ev.message || "Something went wrong."); break;
    default: break;
  }
}

// POSTs and reads the Server-Sent Events stream with fetch (EventSource is GET-only).
async function streamRequest(path, options) {
  setStreaming(true);
  try {
    const res = await api(path, options);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (!data) continue;
        try { handleEvent(JSON.parse(data)); } catch (_) { /* ignore malformed frame */ }
      }
    }
  } catch (err) {
    addError(err.message || "Connection lost. Please try again.");
  } finally {
    setStreaming(false);
  }
}

async function sendChat(text, photoBlob, { hidden = false } = {}) {
  const form = new FormData();
  form.append("text", text);
  if (photoBlob) form.append("image", photoBlob, "photo.jpg");
  if (!hidden) addUserMessage(text, photoBlob ? URL.createObjectURL(photoBlob) : null);
  await streamRequest("/api/chat", { method: "POST", body: form });
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

// ------------------------------------------------------------- session
async function openSession({ fresh = false } = {}) {
  messagesEl().replaceChildren();
  const res = await api("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new: fresh }),
  });
  const session = await res.json();
  if (session.is_new) {
    // Hidden greeting so the coach runs its check-ins (FR-8).
    await sendChat(state.config.greeting_text, null, { hidden: true });
    return;
  }
  const history = await (await api("/api/history")).json();
  for (const m of history.messages) {
    if (m.role === "user") addUserMessage(m.text, null, m.has_image);
    else if (m.role === "coach") addCoachMessage(m.text, m.author);
    else if (m.role === "decision") addDecision(m.confirmed, m.title);
  }
  for (const card of history.pending_confirmations) addConfirmationCard(card);
  scrollToBottom();
}

// ------------------------------------------------------------- dashboard
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of [].concat(children)) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const shortDate = (iso) => { const [, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}`; };

function weightChart(points) {
  const W = 340, H = 170, L = 34, R = 8, T = 10, B = 22;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Weight trend chart" });
  if (!points.length) return svg;
  const vals = points.flatMap((p) => [p.weight_kg, p.moving_average_kg]);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 1) { min -= 0.5; max += 0.5; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const x = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
  const y = (v) => T + ((max - v) * (H - T - B)) / (max - min);
  for (let k = 0; k <= 3; k++) {
    const v = min + ((max - min) * k) / 3;
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "#e2e9e7", "stroke-width": 1 }));
    svg.append(svgEl("text", { x: L - 4, y: y(v) + 3, "text-anchor": "end" }, v.toFixed(1)));
  }
  const ma = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.moving_average_kg).toFixed(1)}`).join(" ");
  svg.append(svgEl("path", { d: ma, fill: "none", stroke: "#0f766e", "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  points.forEach((p, i) => svg.append(svgEl("circle", { cx: x(i), cy: y(p.weight_kg), r: 3, fill: "#f97316", opacity: 0.85 },
    [svgEl("title", {}, `${p.local_date}: ${p.weight_kg} kg (7-day avg ${p.moving_average_kg} kg)`)])));
  const labelIdx = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  labelIdx.forEach((i) => svg.append(svgEl("text", { x: x(i), y: H - 6, "text-anchor": "middle" }, shortDate(points[i].local_date))));
  return svg;
}

function kcalChart(days) {
  const W = 340, H = 170, L = 34, R = 8, T = 10, B = 34;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Daily calories versus target" });
  const target = days.find((d) => d.target_calories_kcal)?.target_calories_kcal || null;
  const max = Math.max(target || 0, ...days.map((d) => d.calories_kcal), 500) * 1.1;
  const slot = (W - L - R) / days.length;
  const y = (v) => T + ((max - v) * (H - T - B)) / max;
  for (let k = 0; k <= 2; k++) {
    const v = (max / 1.1) * (k / 2);
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: "#e2e9e7" }));
    svg.append(svgEl("text", { x: L - 4, y: y(v) + 3, "text-anchor": "end" }, fmt(v)));
  }
  days.forEach((d, i) => {
    const over = d.target_calories_kcal && d.calories_kcal > d.target_calories_kcal;
    const h = Math.max(0, y(0) - y(d.calories_kcal));
    svg.append(svgEl("rect", {
      x: L + i * slot + slot * 0.18, y: y(d.calories_kcal), width: slot * 0.64, height: h, rx: 3,
      fill: d.meals_logged ? (over ? "#f97316" : "#14b8a6") : "#e2e9e7",
    }, [svgEl("title", {}, `${d.local_date}: ${fmt(d.calories_kcal)} kcal, ${fmt(d.protein_g)} g protein`)]));
    const cx = L + i * slot + slot / 2;
    if (d.meals_logged) {
      svg.append(svgEl("circle", { cx, cy: H - 24, r: 3.5, fill: d.protein_target_hit ? "#16a34a" : "#fca5a5" }));
    }
    if (i % 3 === 1 || i === days.length - 1) svg.append(svgEl("text", { x: cx, y: H - 6, "text-anchor": "middle" }, shortDate(d.local_date)));
  });
  if (target) {
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(target), y2: y(target), stroke: "#12211f", "stroke-dasharray": "4 3", "stroke-width": 1.2 }));
    svg.append(svgEl("text", { x: W - R, y: y(target) - 3, "text-anchor": "end" }, `target ${fmt(target)}`));
  }
  return svg;
}

function progressRow(label, value, target, unit) {
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  return [
    el("div", { class: "row" }, [el("span", { text: label }), el("span", { text: `${fmt(value)} / ${fmt(target)} ${unit}` })]),
    el("div", { class: `progress ${target && value > target ? "over" : ""}` }, [el("span", { style: `width:${pct}%` })]),
  ];
}

function renderDashboard(d) {
  const root = $("dashboard");
  root.replaceChildren();
  if (!d.has_profile) {
    root.append(el("div", { class: "card wide empty" }, [
      el("div", { class: "big-emoji", text: "🎯" }),
      el("h2", { class: "center", text: "No profile yet" }),
      el("p", { class: "muted", text: "Tell your coach your goal, body stats and schedule in the chat, and your progress will show up here." }),
    ]));
    return;
  }
  const t = d.targets;
  root.append(el("div", { class: "card" }, [
    el("h2", {}, ["Daily targets", el("span", { class: "sub", text: humanize(d.goal) })]),
    t ? el("div", { class: "stat-grid" }, [
      el("div", { class: "stat hero" }, [el("div", { class: "v", text: `${fmt(t.daily_calories_kcal)} kcal` }), el("div", { class: "l", text: "calories per day" })]),
      el("div", { class: "stat" }, [el("div", { class: "v", text: `${fmt(t.protein_g)}g` }), el("div", { class: "l", text: "protein" })]),
      el("div", { class: "stat" }, [el("div", { class: "v", text: `${fmt(t.carbs_g)}g` }), el("div", { class: "l", text: "carbs" })]),
      el("div", { class: "stat" }, [el("div", { class: "v", text: `${fmt(t.fat_g)}g` }), el("div", { class: "l", text: "fat" })]),
      el("div", { class: "stat" }, [el("div", { class: "v", text: fmt(t.tdee_kcal) }), el("div", { class: "l", text: "TDEE" })]),
    ]) : el("p", { class: "muted", text: "Targets will appear once your coach calculates them." }),
  ]));

  const today = d.nutrition.today;
  root.append(el("div", { class: "card" }, [
    el("h2", {}, ["Today", el("span", { class: "sub", text: d.today })]),
    ...progressRow("Calories", today.consumed.calories_kcal, today.target_calories_kcal, "kcal"),
    ...progressRow("Protein", today.consumed.protein_g, today.target_protein_g, "g"),
    el("p", { class: "muted small", text: today.remaining_calories_kcal === null ? "" :
      `Remaining: ${fmt(today.remaining_calories_kcal)} kcal, ${fmt(today.remaining_protein_g)} g protein. Meal values are estimates.` }),
  ]));

  const w = d.weight;
  const change = (v) => (v === null || v === undefined ? "–" : `${v > 0 ? "+" : ""}${fmt(v, 1)} kg`);
  root.append(el("div", { class: "card wide" }, [
    el("h2", {}, ["Weight trend", el("span", { class: "sub", text: "7-day moving average" })]),
    w.points.length ? weightChart(w.points) : el("p", { class: "muted", text: "Log your weight in the chat (e.g. “81.5 kg this morning”) to see your trend." }),
    el("div", { class: "stat-grid" }, [
      el("div", { class: "stat" }, [el("div", { class: "v", text: fmt(w.latest_moving_average_kg, 1) }), el("div", { class: "l", text: "7-day avg" })]),
      el("div", { class: "stat" }, [el("div", { class: "v", text: fmt(w.latest_weight_kg, 1) }), el("div", { class: "l", text: "latest" })]),
      el("div", { class: "stat" }, [el("div", { class: "v", text: change(w.change_since_start_kg) }), el("div", { class: "l", text: "since start" })]),
      el("div", { class: "stat" }, [el("div", { class: "v", text: change(w.change_vs_last_month_kg) }), el("div", { class: "l", text: "vs last month" })]),
    ]),
    el("div", { class: "legend" }, [
      el("span", {}, [el("i", { style: "background:#0f766e" }), "7-day average"]),
      el("span", {}, [el("i", { style: "background:#f97316" }), "daily weigh-in"]),
    ]),
  ]));

  const n = d.nutrition;
  root.append(el("div", { class: "card wide" }, [
    el("h2", {}, ["Calories vs target", el("span", { class: "sub", text: "last 14 days" })]),
    kcalChart(n.days),
    el("div", { class: "legend" }, [
      el("span", {}, [el("i", { style: "background:#14b8a6" }), "within target"]),
      el("span", {}, [el("i", { style: "background:#f97316" }), "over target"]),
      el("span", {}, [el("i", { style: "background:#16a34a;border-radius:50%" }), "protein hit"]),
      el("span", {}, [el("i", { style: "background:#fca5a5;border-radius:50%" }), "protein missed"]),
    ]),
  ]));

  root.append(el("div", { class: "card" }, [
    el("h2", {}, ["Protein target", el("span", { class: "sub", text: "last 14 days" })]),
    el("div", { class: "week-ring" }, [
      el("div", { class: "big", text: `${n.protein_hit_days}/${n.days.length}` }),
      el("div", { class: "muted small", text: `days hit (${n.days_logged} days with meals logged)` }),
    ]),
    el("div", { class: "pill-row" }, n.days.map((day) => el("span", {
      class: `pill ${day.meals_logged ? (day.protein_target_hit ? "hit" : "miss") : ""}`,
      title: `${day.local_date}: ${fmt(day.protein_g)} g`,
    }))),
  ]));

  const wk = d.week;
  const pct = wk.planned_sessions ? Math.min(100, (wk.completed_sessions / wk.planned_sessions) * 100) : 0;
  root.append(el("div", { class: "card" }, [
    el("h2", {}, ["Workouts this week", el("span", { class: "sub", text: `${shortDate(wk.week_start)} – ${shortDate(wk.week_end)}` })]),
    el("div", { class: "week-ring" }, [
      el("div", { class: "big", text: `${wk.completed_sessions}/${wk.planned_sessions || "–"}` }),
      el("div", { class: "muted small", text: wk.planned_sessions ? "sessions done / planned" : "sessions done (no plan yet)" }),
    ]),
    el("div", { class: "progress" }, [el("span", { style: `width:${pct}%` })]),
  ]));

  const plan = d.plan;
  root.append(el("div", { class: "card wide" }, [
    el("h2", {}, ["Current plan", el("span", { class: "sub", text: plan ? plan.title : "" })]),
    plan ? el("div", {}, plan.sessions.map((s) => el("div", { class: "plan-session" }, [
      el("div", {}, [el("span", { class: "day", text: s.day_of_week }), " · ", s.focus]),
      el("div", { class: "meta", text: `~${s.estimated_minutes} min · ${s.exercises.length} exercises` }),
      el("ul", {}, s.exercises.map((e) => el("li", {
        text: `${e.name}: ${e.sets} × ${e.reps ? `${e.reps} reps` : `${e.duration_seconds}s`}${e.target_rpe ? ` @ RPE ${e.target_rpe}` : ""}`,
      }))),
    ]))) : el("p", { class: "muted", text: "Ask your coach: “Make me a plan for this week.”" }),
    plan && plan.progression_notes ? el("p", { class: "muted small", text: plan.progression_notes }) : null,
  ]));
}

async function loadDashboard() {
  const root = $("dashboard");
  if (!state.dashboardLoaded) root.replaceChildren(el("p", { class: "muted center", text: "Loading your progress..." }));
  try {
    const data = await (await api("/api/dashboard")).json();
    renderDashboard(data);
    state.dashboardLoaded = true;
  } catch (err) {
    root.replaceChildren(el("div", { class: "card wide empty" }, [el("p", { class: "muted", text: err.message })]));
  }
}

// ------------------------------------------------------------- tabs
function switchTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  $("chat-view").hidden = name !== "chat";
  $("dashboard-view").hidden = name !== "dashboard";
  if (name === "dashboard") loadDashboard();
  else scrollToBottom();
}

// ------------------------------------------------------------- auth
function showSignIn() {
  $("app-view").hidden = true;
  $("user-actions").hidden = true;
  $("signin-view").hidden = false;
  const render = () => {
    if (!state.config.google_client_id) {
      $("signin-error").textContent = "Google sign-in is not configured on this server.";
      return;
    }
    window.google.accounts.id.initialize({ client_id: state.config.google_client_id, callback: onGoogleCredential, ux_mode: "popup" });
    window.google.accounts.id.renderButton($("gis-button"), { theme: "filled_blue", size: "large", shape: "pill", text: "signin_with" });
  };
  if (window.google && window.google.accounts) render();
  else {
    const wait = setInterval(() => { if (window.google && window.google.accounts) { clearInterval(wait); render(); } }, 100);
  }
}

async function onGoogleCredential(response) {
  $("signin-error").textContent = "";
  try {
    await api("/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });
    await startApp();
  } catch (err) {
    $("signin-error").textContent = err.message;
  }
}

async function startApp() {
  $("signin-view").hidden = true;
  $("app-view").hidden = false;
  $("user-actions").hidden = false;
  $("logout-btn").hidden = state.config.dev_auth_bypass;
  try {
    await openSession();
  } catch (err) {
    addError(err.message);
  }
}

async function boot() {
  state.config = await (await fetch("/api/config")).json();

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
    state.dashboardLoaded = false;
  });
  $("message-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  $("message-input").addEventListener("input", (e) => {
    e.target.style.height = "";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
  });
  $("camera-input").addEventListener("change", onPhotoSelected);
  $("gallery-input").addEventListener("change", onPhotoSelected);
  $("photo-remove").addEventListener("click", clearPhoto);
  for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  $("new-chat-btn").addEventListener("click", async () => {
    if (state.streaming) return;
    switchTab("chat");
    try { await openSession({ fresh: true }); } catch (err) { addError(err.message); }
  });
  $("logout-btn").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    if (window.google && window.google.accounts) window.google.accounts.id.disableAutoSelect();
    showSignIn();
  });

  const me = await fetch("/api/me", { credentials: "same-origin" });
  if (me.ok) await startApp();
  else showSignIn();
}

document.addEventListener("DOMContentLoaded", () => {
  boot().catch((err) => {
    document.body.append(el("p", { class: "msg error", text: `Could not start the app: ${err.message}` }));
  });
});
