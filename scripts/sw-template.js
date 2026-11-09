// Service worker: the app works offline after the first scan.
// vite.config.ts fills in the three constants below at build time.

const SHELL = "__SHELL_CACHE__";
const VENDOR = "__VENDOR_CACHE__";
const FILES = __SHELL_FILES__;

const scope = new URL(self.registration.scope);

// Install: the app shell (HTML, bundles, fonts, zxing wasm), about 1.5 MB.
// Tesseract (vendor/, about 30 MB for all its core variants) is cached when a
// scan first loads it, so only the core this browser picks is stored.
// No automatic skipWaiting: an open page keeps the old worker and the files it
// was built with. The new version takes over on the next start, or when the page
// asks for it (the "Aktualizovať" button sends "skip-waiting").
// cache: "reload" skips the browser's HTTP cache: GitHub Pages sends max-age=600,
// and a new worker could otherwise store the previous index.html.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(FILES.map((f) => new Request(new URL(f, scope).href, { cache: "reload" })))),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== VENDOR).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

// The page itself: the network first, so a new version shows as soon as it is
// deployed; the cached copy when offline or after 4 seconds of a bad signal.
async function page(request) {
  const cache = await caches.open(SHELL);
  const cached = () => cache.match(new URL("index.html", scope).href);
  try {
    // no-cache: revalidate with the server (a cheap 304), not the HTTP cache's 10-minute copy.
    const response = await Promise.race([
      fetch(request.url, { cache: "no-cache", credentials: "same-origin" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
    ]);
    if (response.ok) return response;
    return (await cached()) ?? response;
  } catch (e) {
    const hit = await cached();
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (request.mode === "navigate") {
    event.respondWith(page(request));
  } else if (url.pathname.startsWith(scope.pathname + "vendor/")) {
    event.respondWith(cacheFirst(request, VENDOR));
  } else {
    event.respondWith(cacheFirst(request, SHELL));
  }
});
