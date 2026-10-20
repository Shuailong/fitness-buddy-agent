// Minimal service worker: makes the app installable everywhere and shows a
// friendly offline page for navigations. It never caches app data or API
// responses, so deploys are never served stale.
const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · Fitness Buddy</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0F1215;color:#F3F5F7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px">
<div><div style="font-size:44px">📶</div><h1 style="font-size:20px;margin:12px 0 6px">You're offline · 网络已断开</h1>
<p style="color:#9BA3AE;margin:0 0 18px">Fitness Buddy needs a connection to reach your coach.<br>请连接网络后重试。</p>
<button onclick="location.reload()" style="border:0;border-radius:999px;padding:12px 22px;background:#A3E635;color:#0B0F07;font-weight:700;font-size:15px">Retry · 重试</button></div></body>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } })),
  );
});
