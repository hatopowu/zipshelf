// オフライン起動用 Service Worker。
// 方針＝起動資産はキャッシュ優先＋バックグラウンド更新(オフライン即時起動)。
// ASSETS を増減したら VER を上げること。
var CACHE_PREFIX = "zipshelf-";
var VER = "zipshelf-v3";
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
        // CacheStorage はオリジン単位。同じ GitHub Pages オリジンにある
        // TextShelf など、別アプリのキャッシュは削除しない。
        return Promise.all(keys.filter(function (k) {
          return k.indexOf(CACHE_PREFIX) === 0 && k !== VER;
        })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  // serve.py と同一オリジンで開いた時も、取込APIや原本をアプリキャッシュへ複製しない。
  if (url.pathname === "/list" || url.pathname === "/thumb" ||
      url.pathname === "/cert" || url.pathname.indexOf("/zips/") === 0) return;

  var cacheP = caches.open(VER);
  var updateP = cacheP.then(function (cache) {
    return fetch(req).then(function (res) {
      if (res && res.ok) {
        return cache.put(req, res.clone()).then(function () { return res; });
      }
      return res;
    });
  });
  var responseP = cacheP.then(function (cache) {
    return cache.match(req, { ignoreSearch: true });
  }).then(function (cached) {
    // キャッシュ済みなら即時返却。未キャッシュ時だけネットワークを待つ。
    return cached || updateP;
  });

  e.waitUntil(updateP.catch(function () {}));
  e.respondWith(responseP);
});
