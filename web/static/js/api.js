// Network helpers: JSON/fetch wrapper and the SSE-over-fetch reader.
import { actions } from "./state.js";
import { t, getLang } from "./i18n.js";

/** Error with the HTTP status and, for 429s, { code, scope, retryAfter (seconds) }. */
export class ApiError extends Error {
  constructor(message, { status = 0, code = null, scope = null, retryAfter = 0, email = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.scope = scope;
    this.retryAfter = retryAfter;
    this.email = email;
  }
}

export const isRateLimited = (err) => Boolean(err && (err.code === "rate_limited" || err.status === 429));

export async function api(path, options = {}) {
  // The server localizes error messages to the UI language.
  const headers = { ...(options.headers || {}), "X-UI-Lang": getLang() };
  const res = await fetch(path, { credentials: "same-origin", ...options, headers });
  if (res.status === 401) {
    actions.showSignIn();
    throw new ApiError(t("error.signIn"), { status: 401 });
  }
  if (!res.ok) {
    let detail = t("error.request", { status: res.status });
    let body = null;
    try { body = await res.json(); detail = (body && typeof body.detail === "string" && body.detail) || detail; } catch (_) { /* not JSON */ }
    const header = Number(res.headers.get("Retry-After"));
    const retryAfter = Math.max(0, Math.ceil(Number(body && body.retry_after) || (Number.isFinite(header) ? header : 0)));
    throw new ApiError(detail, {
      status: res.status,
      code: (body && body.code) || (res.status === 429 ? "rate_limited" : null),
      scope: (body && body.scope) || null,
      retryAfter,
      email: (body && body.email) || null,
    });
  }
  return res;
}

export async function getJson(path) {
  return (await api(path)).json();
}

export function postJson(path, body) {
  return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** POSTs and reads a Server-Sent Events stream with fetch (EventSource is GET-only). */
export async function readEventStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (frame) => {
    const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!data) return;
    let event;
    try { event = JSON.parse(data); } catch (_) { return; /* ignore malformed frame */ }
    onEvent(event);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      flush(frame);
    }
  }
  if (buffer.trim()) flush(buffer);
}
