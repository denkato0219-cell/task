// Offline cache for the home-screen app, and showing notifications sent by the server.
const CACHE = "kyou-yotei-v4";
const FILES = ["./", "index.html", "config.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;
  // network first so updates arrive; cache when offline
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});

self.addEventListener("push", e => {
  let msg = { title: "きょうのよてい", body: "" };
  try { msg = { ...msg, ...e.data.json() }; } catch (err) { if (e.data) msg.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(msg.title, {
    body: msg.body, tag: msg.tag, icon: "icon-192.png", badge: "icon-192.png", data: { url: "./" },
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const open = list.find(c => "focus" in c);
    return open ? open.focus() : self.clients.openWindow(e.notification.data?.url || "./");
  }));
});
