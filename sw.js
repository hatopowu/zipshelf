// オフライン起動用 Service Worker。
// 方針＝ネットワーク優先(常に最新)・失敗時のみキャッシュ(オフライン起動)。
// ASSETS を増減したら VER を上げること。
var VER = "zipshelf-v2";
var ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./zip.min.js",
  "./pdf.min.js",
  "./pdf.worker.min.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VER)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== VER; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) {
        var cp = res.clone();
        caches.open(VER).then(function (c) { c.put(req, cp); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (r) {
        if (r) return r;
        throw new Error("offline: " + req.url);
      });
    })
  );
});
