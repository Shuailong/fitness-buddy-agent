// DOM, formatting and markdown helpers. No innerHTML with untrusted text:
// everything goes through textContent, except the markdown renderer, which
// escapes its input before adding its own tags.

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_SPRITE = "/static/icons.svg";

export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v; // only used with escaped/sanitized markup
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(node, c);
    else node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/** Material Symbols icon from the sprite; decorative unless a label is given. */
export function icon(name, { cls = "", label = null, fill = false } = {}) {
  const svg = svgEl("svg", { class: `icon ${cls}`.trim(), viewBox: "0 0 24 24", focusable: "false" });
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  svg.append(svgEl("use", { href: `${ICON_SPRITE}#i-${name}${fill ? "-fill" : ""}` }));
  return svg;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export const isNum = (n) => typeof n === "number" && Number.isFinite(n);

export const fmt = (n, digits = 0) =>
  !isNum(n) ? "–" : Number(n).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const signed = (n, digits = 1) => (!isNum(n) ? "–" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n), digits)}`);

export const humanize = (s) => String(s ?? "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const capitalize = (s) => String(s ?? "").replace(/^\w/, (c) => c.toUpperCase());

/** Parses a YYYY-MM-DD string as a local calendar date (no time zone shift). */
export function parseDate(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

export const shortDate = (iso) => parseDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function clockTime(isoDateTime, timeZone) {
  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
  } catch (_) {
    return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ------------------------------------------------------------- markdown
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
}

/** Small, safe markdown subset: paragraphs, lists, headings, tables, bold/italic/code. */
export function renderMarkdown(src) {
  const lines = escapeHtml(String(src).replace(/\r\n/g, "\n")).split("\n");
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

/** Renders [{text, strong}] segments (from the pure tip builders) safely. */
export function richText(parts) {
  return parts.map((p) => (p.strong ? el("strong", { text: p.text }) : document.createTextNode(p.text)));
}
