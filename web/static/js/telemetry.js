// Fire-and-forget product telemetry (POST /api/telemetry). Only event names
// and small enum-like props are sent: never message text or personal data.
const ENDPOINT = "/api/telemetry";
let enabled = false;

/** Telemetry is only sent while signed in (the endpoint needs a session). */
export function enableTelemetry(on = true) {
  enabled = Boolean(on);
}

/** track("tab_view", { tab: "plan" }); props: flat string/number/bool values. */
export function track(name, props = null) {
  if (!enabled || !name) return;
  const payload = { name };
  if (props && Object.keys(props).length) payload.props = props;
  const body = JSON.stringify(payload);
  try {
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
  } catch (_) { /* fall back to fetch */ }
  try {
    fetch(ENDPOINT, {
      method: "POST", credentials: "same-origin", keepalive: true,
      headers: { "Content-Type": "application/json" }, body,
    }).catch(() => {});
  } catch (_) { /* telemetry must never break the app */ }
}
