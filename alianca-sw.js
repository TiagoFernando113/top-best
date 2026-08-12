// Service worker do Portal [TOP] Best — só para instalabilidade/PWA.
// Network-first (o portal precisa da internet pro Supabase); cache é fallback do shell.
const CACHE = "top-portal-v3";
const SHELL = ["./", "index.html", "alianca-manifest.json", "alianca-icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("top-portal-") && k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(d.title || "[TOP] Best", {
      body: d.body || "",
      icon: "alianca-icon.svg",
      badge: "alianca-icon.svg",
      vibrate: [80, 40, 80],
      data: { url: d.url || "./" },
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url.indexOf("top-best") > -1 && "focus" in c) return c.focus(); }
      return clients.openWindow ? clients.openWindow(url) : null;
    })
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // sempre revalida com o servidor (não serve HTML velho do cache do navegador)
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then((r) => {
        if (r && r.ok && e.request.url.indexOf("supabase.co") === -1) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return r;
      })
      .catch(() => caches.match(e.request))
  );
});
