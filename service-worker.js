/* Velouria 1200 — Service Worker
 * Cache-first for app shell, network-first for everything else.
 * Cross-origin resources (Google Fonts) are not cached: they fall back to
 * system fonts when offline.
 */
const CACHE_NAME = "velouria-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./script.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch(() => {
        // Best-effort: precache as much as we can.
        return Promise.all(
          APP_SHELL.map((url) => cache.add(url).catch(() => null))
        );
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isAppShell(url) {
  // Match scope-relative app-shell paths
  const path = url.pathname.replace(/\/+$/, "/");
  const tails = [
    "/",
    "/index.html",
    "/script.js",
    "/styles.css",
    "/manifest.webmanifest",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
  ];
  return tails.some((t) => path.endsWith(t));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Don't intercept cross-origin (e.g. Google Fonts). Let the browser handle them.
  if (url.origin !== self.location.origin) return;

  if (isAppShell(url)) {
    // Cache-first with network fallback
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          }).catch(() => caches.match("./index.html"));
        })
      )
    );
    return;
  }

  // Network-first for everything else (e.g. blob: URLs aren't really hit here,
  // but other same-origin requests get fresh content when online)
  event.respondWith(
    fetch(req).then((res) => {
      return res;
    }).catch(() => caches.match(req))
  );
});
