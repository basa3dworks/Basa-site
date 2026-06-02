const BASA_CACHE = "basa-pwa-20260602";
const BASA_STATIC = [
  "/",
  "/manifest.json",
  "/react-app/index.html",
  "/react-app/styles.css?v=20260602-pwa",
  "/react-app/main.js?v=20260602-pwa",
  "/react-app/vendor/react.production.min.js",
  "/react-app/vendor/react-dom.production.min.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(BASA_CACHE)
      .then((cache) => cache.addAll(BASA_STATIC))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== BASA_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/admin")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(BASA_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok && ["style", "script", "image", "font"].includes(request.destination)) {
        const copy = response.clone();
        caches.open(BASA_CACHE).then((cache) => cache.put(request, copy));
      }
      return response;
    }))
  );
});
