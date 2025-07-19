const cacheName = "uno-cache-v1";
const assets = [
  "/",
  "/index.html",
  "/style.css",
  "/game.js",
  "/manifest.json",
  "/cards/back.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(cacheName).then(cache => cache.addAll(assets))
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(res => res || fetch(event.request))
  );
});
