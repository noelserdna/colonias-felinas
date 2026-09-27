// Service worker: red primero para páginas (con copia offline), caché primero para estáticos.
const VERSION = "v7";
const STATIC = `static-${VERSION}`;
const PAGES = `pages-${VERSION}`;
const PRECACHE = ["/offline", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-mono.svg", "/icons/icon-192.png", "/icons/badge-96.png"];
// Páginas que se guardan para consultarlas sin conexión (el carnet y el temario).
const OFFLINE_PAGES = [/^\/colonia$/, /^\/documentos$/, /^\/carnet$/, /^\/temario$/, /^\/temario\/[^/]+$/, /^\/$/];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![STATIC, PAGES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;

  if (url.pathname.startsWith("/_astro/") || url.pathname.startsWith("/icons/") || url.pathname.startsWith("/img/") || url.pathname.startsWith("/branding/")) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(STATIC).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
    return;
  }

  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) {
    const cacheable = OFFLINE_PAGES.some((re) => re.test(url.pathname));
    e.respondWith(
      fetch(req)
        .then((res) => {
          // Solo se guarda si la respuesta es la página final (no una redirección al login).
          if (cacheable && res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put(url.pathname, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(url.pathname, { cacheName: PAGES })) || caches.match("/offline")),
    );
  }
});

// Al cerrar sesión se borran las páginas guardadas (contienen datos personales) y se cancelan las
// notificaciones de este dispositivo (el servidor borra la suscripción en el siguiente envío, al recibir 410).
self.addEventListener("message", (e) => {
  if (e.data !== "logout") return;
  e.waitUntil(
    Promise.all([
      caches.delete(PAGES),
      self.registration.pushManager.getSubscription().then((s) => s && s.unsubscribe()),
      "clearAppBadge" in self.navigator ? self.navigator.clearAppBadge() : null,
    ]).catch(() => {}),
  );
});

// ---------- Notificaciones push ----------
// El servidor envía { title, body, url, tag, badge } cifrado (ver src/lib/webpush.ts).

self.addEventListener("push", (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { body: e.data ? e.data.text() : "" };
  }
  const tasks = [
    // iOS exige mostrar siempre una notificación al recibir un push.
    self.registration.showNotification(d.title || "Colonias Felinas", {
      body: d.body || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      lang: "es",
      tag: d.tag,
      renotify: Boolean(d.tag),
      data: { url: d.url || "/" },
    }),
  ];
  // Número en el icono de la app con los avisos sin leer.
  if (typeof d.badge === "number" && "setAppBadge" in self.navigator) {
    tasks.push(d.badge > 0 ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge());
  }
  e.waitUntil(Promise.all(tasks).catch(() => {}));
});

// Al tocar la notificación: reutiliza la ventana abierta de la app o abre una nueva en la página del aviso.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = windows.find((c) => new URL(c.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        return win.navigate(url).catch(() => self.clients.openWindow(url));
      }
      return self.clients.openWindow(url);
    })(),
  );
});

// Si el navegador renueva la suscripción, se vuelve a registrar en el servidor.
self.addEventListener("pushsubscriptionchange", (e) => {
  const options = e.oldSubscription && e.oldSubscription.options;
  if (!options) return;
  e.waitUntil(
    self.registration.pushManager.subscribe(options).then((sub) =>
      fetch("/api/push/suscripcion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) }),
    ),
  );
});
