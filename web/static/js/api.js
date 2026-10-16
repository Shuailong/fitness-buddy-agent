// Network helpers: JSON/fetch wrapper and the SSE-over-fetch reader.
import { actions } from "./state.js";

export async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  if (res.status === 401) {
    actions.showSignIn();
    throw new Error("Sign in required.");
  }
  if (!res.ok) {
    let detail = `Request failed (${res.status}).`;
    try { detail = (await res.json()).detail || detail; } catch (_) { /* not JSON */ }
    throw new Error(detail);
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
