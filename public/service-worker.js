// Minimal placeholder; feel free to remove if not using PWA caching
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(clients.claim()));
