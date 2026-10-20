// Service worker: installable app + offline app shell.
//
// - The app shell (HTML, JS, CSS, fonts, icons) is precached per deploy
//   (cache name = content hash of the static files), so the app opens and
//   shows your last-synced data without a connection.
// - Pages: network first, falling back to the cached shell, then to a small
//   offline page. Static files: cache first (the cache is per deploy).
// - API responses (your data) are never stored here; the app keeps its own
//   small last-synced snapshot in localStorage and clears it on sign-out.
const VERSION = "__ASSET_VERSION__";
const CACHE = `fb-shell-${VERSION}`;
const PRECACHE = __PRECACHE__;

const OFFLINE_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline · Fitness Buddy</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0F1215;color:#F3F5F7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;text-align:center;padding:24px">
<div><div style="font-size:44px">📶</div><h1 style="font-size:20px;margin:12px 0 6px">You're offline · 网络已断开</h1>
<p style="color:#9BA3AE;margin:0 0 18px">Fitness Buddy needs a connection to reach your coach.<br>请连接网络后重试。</p>
<button onclick="location.reload()" style="border:0;border-radius:999px;padding:12px 22px;background:#A3E635;color:#0B0F07;font-weight:700;font-size:15px">Retry · 重试</button></div></body>`;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One failed file must not block the install (e.g. a flaky network).
    await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: "reload", credentials: "same-origin" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("fb-shell-") && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function fromNetworkThenShell(request) {
  try {
    const response = await fetch(request);
    if (response.ok && new URL(request.url).pathname === "/") {
      const cache = await caches.open(CACHE);
      cache.put("/", response.clone());
    }
    return response;
  } catch (_) {
    const path = new URL(request.url).pathname;
    const shell = path === "/" || path === "" ? await caches.match("/", { cacheName: CACHE }) : await caches.match(request, { cacheName: CACHE, ignoreSearch: true });
    return shell || (await caches.match("/", { cacheName: CACHE })) || new Response(OFFLINE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") cache.put(request, response.clone());
    return response;
  } catch (err) {
    // Same file under another ?v= (e.g. right after a deploy): better than nothing.
    const loose = await cache.match(request, { ignoreSearch: true });
    if (loose) return loose;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    // Only the app pages; auth redirects and APIs always hit the network.
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;
    event.respondWith(fromNetworkThenShell(request));
    return;
  }
  if (url.pathname.startsWith("/static/") && !url.pathname.startsWith("/static/audio/")) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener("message", (event) => {
  if (event.data === "fb:version") event.source && event.source.postMessage({ type: "fb:version", version: VERSION });
});
