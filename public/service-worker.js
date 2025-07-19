const CACHE_NAME = "uno-game-cache-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/game.js",
  "/assets/cards/back.png",
  "/socket.io/socket.io.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => response || fetch(event.request))
  );
});
