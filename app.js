(function () {
  "use strict";

  var IMG_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
  var ZIP_RE = /\.(zip|cbz)$/i;
  var THUMB_PX = 320;          // 本棚サムネの長辺
  var WRITE_CHUNK = 8 * 1024 * 1024;

  var slides = [];      // { name, entry } ← entry は zip.js のエントリ（遅延展開）
  var order = [];       // 表示順（index の配列）
  var pos = 0;          // order 内の現在位置
  var urlCache = {};    // slideIndex -> objectURL（現在地付近のみ保持して省メモリ）
  var showToken = 0;    // 非同期表示の競合ガード
  var playing = false;
  var curBook = "";     // 開いている zip 名（読書位置の保存キー）
  var timer = null;
  var wakeLock = null;

  function lsBool(k, d) { var v = localStorage.getItem(k); return v === null ? d : v === "1"; }
  var loop = lsBool("zsh_loop", false);
  var shuffle = lsBool("zsh_shuf", false);
  var rtl = lsBool("zsh_rtl", true);         // 既定オン（右から左）
  var gaugeOn = lsBool("zsh_gauge", true);

  var $ = function (id) { return document.getElementById(id); };
  var pic = $("pic"), info = $("info"), ctrl = $("ctrl"), topbar = $("topbar");

  // 上下ツールバーの表示は常にペアで切り替える
  function setBars(vis) {
    ctrl.classList.toggle("hidden", !vis);
    topbar.classList.toggle("hidden", !vis);
    if (vis) { clearTimeout(infoTimer); info.classList.add("hidden"); }  // バー表示中はシークラベルが n/N を兼ねる
  }
  function barsVisible() { return !ctrl.classList.contains("hidden"); }

  function naturalCmp(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }
  function bookTitle(name) { return name.replace(ZIP_RE, ""); }
  function fmtSize(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + "GB";
    if (b >= 1e6) return Math.round(b / 1e6) + "MB";
    return Math.max(1, Math.round(b / 1e3)) + "KB";
  }
  function toast(msg) {
    var d = document.createElement("div");
    d.textContent = msg;
    d.style.cssText = "position:fixed;left:50%;bottom:18%;transform:translateX(-50%);" +
      "background:rgba(0,0,0,.85);color:#fff;padding:10px 16px;border-radius:10px;" +
      "font-size:14px;z-index:50;max-width:80vw;text-align:center;";
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 1800);
  }

  // ---- 本のメタ情報（追加日・読書位置）。実体は OPFS、メタは localStorage ----
  var meta = {};
  try { meta = JSON.parse(localStorage.getItem("zsh_meta") || "{}"); } catch (e) { meta = {}; }
  function saveMeta() {
    try { localStorage.setItem("zsh_meta", JSON.stringify(meta)); } catch (e) {}
  }

  // ---- OPFS（端末内ストレージ）----
  var rootDirP = null;
  function opfsRoot() {
    if (!rootDirP) {
      rootDirP = (navigator.storage && navigator.storage.getDirectory)
        ? navigator.storage.getDirectory()
        : Promise.reject(new Error("OPFS未対応"));
    }
    return rootDirP;
  }
  function thumbsDir(create) {
    return opfsRoot().then(function (r) { return r.getDirectoryHandle("thumbs", { create: !!create }); });
  }
  function thumbName(name) { return name + ".jpg"; }
  function canWrite() {
    return !!(window.FileSystemFileHandle && FileSystemFileHandle.prototype.createWritable);
  }

  async function listBooks() {
    var root = await opfsRoot();
    var items = [];
    for await (var h of root.values()) {
      if (h.kind === "file" && ZIP_RE.test(h.name)) {
        var f = await h.getFile();
        items.push({
          name: h.name, size: f.size,
          added: (meta[h.name] && meta[h.name].added) || f.lastModified || 0
        });
      }
    }
    return items;
  }

  // ---- 本棚 ----
  var editing = false;
  var shelfUrls = [];   // サムネの objectURL（再描画で解放）
  var sortKey = localStorage.getItem("zsh_sortKey") || "date";   // 既定：追加日の新しい順
  var sortAsc = localStorage.getItem("zsh_sortAsc") === "1";

  function applySort(arr) {
    var a = arr.slice();
    a.sort(function (x, y) {
      var r = (sortKey === "date") ? (x.added || 0) - (y.added || 0) : naturalCmp(x.name, y.name);
      return sortAsc ? r : -r;
    });
    return a;
  }
  function setSort(key) {
    if (sortKey === key) sortAsc = !sortAsc;
    else { sortKey = key; sortAsc = (key === "name"); }
    localStorage.setItem("zsh_sortKey", sortKey);
    localStorage.setItem("zsh_sortAsc", sortAsc ? "1" : "0");
    updateSortUI();
    renderShelf();
  }
  function updateSortUI() {
    var arw = sortAsc ? " ↑" : " ↓";
    $("sortName").textContent = "名前" + (sortKey === "name" ? arw : "");
    $("sortDate").textContent = "追加日" + (sortKey === "date" ? arw : "");
    $("sortName").classList.toggle("on", sortKey === "name");
    $("sortDate").classList.toggle("on", sortKey === "date");
  }

  function makeCard(icon, caption) {
    var c = document.createElement("button");
    c.className = "card";
    var t = document.createElement("div");
    t.className = "thumb";
    t.textContent = icon;
    var cap = document.createElement("div");
    cap.className = "cap";
    cap.textContent = caption;
    var sub = document.createElement("div");
    sub.className = "sub";
    c.appendChild(t); c.appendChild(cap); c.appendChild(sub);
    return c;
  }

  async function fillThumb(el, name) {
    try {
      var td = await thumbsDir(false);
      var fh = await td.getFileHandle(thumbName(name));
      var f = await fh.getFile();
      var u = URL.createObjectURL(f);
      shelfUrls.push(u);
      el.textContent = "";
      el.style.backgroundImage = "url('" + u + "')";
    } catch (e) { /* サムネ無し → 🗜 のまま */ }
  }

  async function renderShelf() {
    var box = $("shelfList");
    shelfUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    shelfUrls = [];
    var items;
    try {
      items = await listBooks();
    } catch (e) {
      // 非secure context 等で OPFS が使えない
      $("nossl").style.display = "block";
      $("shelfWrap").style.display = "none";
      return;
    }
    // 実体が消えたメタは捨てる
    var names = {};
    items.forEach(function (it) { names[it.name] = 1; });
    Object.keys(meta).forEach(function (k) { if (!names[k]) delete meta[k]; });
    saveMeta();
    shelfNames = names;   // サーバ取込ブラウザの「✓取込済」判定用

    $("countLbl").textContent = "📚 " + items.length + "冊";
    box.innerHTML = "";
    applySort(items).forEach(function (it) {
      var c = makeCard("🗜", bookTitle(it.name));
      var m = meta[it.name];
      var sub = fmtSize(it.size);
      if (m && m.total) sub = Math.min((m.pos | 0) + 1, m.total) + "/" + m.total + " ・ " + sub;
      c.querySelector(".sub").textContent = sub;
      c.onclick = function () { editing ? deleteBook(it.name) : openBook(it.name); };
      box.appendChild(c);
      fillThumb(c.querySelector(".thumb"), it.name);
    });
    $("shelfEmpty").style.display = items.length ? "none" : "block";
    updateStorageLine();
  }

  async function updateStorageLine() {
    try {
      var est = await navigator.storage.estimate();
      $("storeLine").textContent =
        "ストレージ使用 " + fmtSize(est.usage || 0) + " / 上限目安 " + fmtSize(est.quota || 0);
    } catch (e) { $("storeLine").textContent = ""; }
  }

  async function deleteBook(name) {
    if (!confirm("「" + bookTitle(name) + "」を本棚から削除しますか？")) return;
    try {
      var root = await opfsRoot();
      await root.removeEntry(name);
      try {
        var td = await thumbsDir(false);
        await td.removeEntry(thumbName(name));
      } catch (e) { /* サムネ無し */ }
      delete meta[name];
      saveMeta();
      renderShelf();
    } catch (e) {
      console.error(e);
      alert("削除失敗: " + name + "\n" + e.message);
    }
  }

  // ---- 取り込み（zip を OPFS へコピー保存）----
  async function importFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return ZIP_RE.test(f.name); });
    if (!files.length) return;
    var root;
    try {
      root = await opfsRoot();
    } catch (e) {
      alert("ストレージ機能が使えません。HTTPS で開いてください。");
      return;
    }
    if (!canWrite()) {
      alert("このブラウザは端末内保存(createWritable)に未対応です。\niOS 18.2 以降 / 最新の Safari・Chrome で使えます。");
      return;
    }
    $("loading").style.display = "flex";
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var exists = false;
      try { await root.getFileHandle(file.name); exists = true; } catch (e) {}
      if (exists && !confirm("「" + bookTitle(file.name) + "」は既にあります。上書きしますか？")) continue;
      try {
        await writeZip(root, file, i + 1, files.length);
        $("loadTxt").textContent = "サムネ作成中 : " + file.name;
        var tb = await makeThumb(file);
        if (tb) {
          var td = await thumbsDir(true);
          var th = await td.getFileHandle(thumbName(file.name), { create: true });
          var w = await th.createWritable();
          await w.write(tb);
          await w.close();
        }
        meta[file.name] = { added: Date.now(), size: file.size, pos: 0, total: 0 };
        saveMeta();
      } catch (e) {
        console.error(e);
        alert("取込失敗: " + file.name + "\n" + e.message);
      }
    }
    $("loading").style.display = "none";
    renderShelf();
  }

  // createWritable は close() で確定＝途中失敗しても壊れた実体は残らない
  async function writeZip(root, file, ith, total) {
    var fh = await root.getFileHandle(file.name, { create: true });
    var w = await fh.createWritable();
    try {
      for (var o = 0; o < file.size; o += WRITE_CHUNK) {
        var end = Math.min(o + WRITE_CHUNK, file.size);
        var buf = await file.slice(o, end).arrayBuffer();
        await w.write(buf);
        $("loadTxt").textContent = "取込中 " + ith + "/" + total + " : " + file.name +
          " (" + Math.round(end / file.size * 100) + "%)";
      }
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (e2) {}
      throw e;
    }
  }

  // 先頭画像を縮小 jpeg にして本棚サムネに使う
  async function makeThumb(file) {
    try {
      var reader = new zip.ZipReader(new zip.BlobReader(file));
      var entries = await reader.getEntries();
      var first = null;
      for (var i = 0; i < entries.length; i++) {
        var en = entries[i];
        if (!en.directory && IMG_RE.test(en.filename) && !/(^|\/)__MACOSX\//.test(en.filename)) {
          if (!first || naturalCmp(en.filename, first.filename) < 0) first = en;
        }
      }
      if (!first) { await reader.close(); return null; }
      var blob = await first.getData(new zip.BlobWriter());
      await reader.close();
      var url = URL.createObjectURL(blob);
      try {
        var img = await new Promise(function (res, rej) {
          var im = new Image();
          im.onload = function () { res(im); };
          im.onerror = rej;
          im.src = url;
        });
        var s = Math.min(1, THUMB_PX / Math.max(img.naturalWidth, img.naturalHeight));
        var cw = Math.max(1, Math.round(img.naturalWidth * s));
        var ch = Math.max(1, Math.round(img.naturalHeight * s));
        var cv = document.createElement("canvas");
        cv.width = cw; cv.height = ch;
        cv.getContext("2d").drawImage(img, 0, 0, cw, ch);
        return await new Promise(function (res) { cv.toBlob(res, "image/jpeg", 0.8); });
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      console.error(e);
      return null;   // サムネ無しで続行
    }
  }

  // ---- サーバ取込（serve.py の https ポートをブラウズして DL → 本棚へ）----
  var srvUrl = localStorage.getItem("zsh_srv") || "";
  var srvDir = "";
  var shelfNames = {};       // 取込済み判定（renderShelf で更新）
  var srvThumbUrls = [];
  var srvThumbQueue = [];
  var srvThumbBusy = false;
  var srvThumbGen = 0;       // フォルダ移動・クローズでサムネ生成を打ち切る世代

  function encPath(p) { return p.split("/").map(encodeURIComponent).join("/"); }
  function joinPath(a, b) { return a ? a + "/" + b : b; }

  function askSrvUrl() {
    var v = prompt("PCサーバのURL（serve.py の https ポート）",
                   srvUrl || "https://192.168.11.15:8443");
    if (!v) return false;
    v = v.trim().replace(/\/+$/, "");
    if (!/^https:\/\//i.test(v)) {
      alert("https:// で始まるURLが必要です（http は混在コンテンツとしてブロックされます）");
      return false;
    }
    srvUrl = v;
    localStorage.setItem("zsh_srv", v);
    return true;
  }

  function openSrv() {
    if (!srvUrl && !askSrvUrl()) return;
    $("srv").classList.remove("hidden");
    srvList(srvDir);
  }
  function closeSrv() {
    srvThumbGen++;
    srvThumbQueue = [];
    srvThumbUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    srvThumbUrls = [];
    $("srv").classList.add("hidden");
    renderShelf();   // 取込結果を本棚へ反映
  }

  async function srvList(dir) {
    var box = $("srvList");
    box.innerHTML = "<div style='opacity:.5;font-size:13px;grid-column:1/-1;text-align:center'>読み込み中...</div>";
    var data;
    try {
      var res = await fetch(srvUrl + "/list?dir=" + encodeURIComponent(dir || ""), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (e) {
      console.error(e);
      box.innerHTML = "";
      alert("サーバに接続できません。\n" +
        "・PC で start-server.bat が動いているか\n" +
        "・URL: " + srvUrl + " が正しいか\n" +
        "・証明書を導入・信頼済みか（初回は Safari で http://<PCのIP>:8000/cert）\n" +
        "を確認してください。");
      return;
    }
    srvDir = data.dir || "";
    renderSrv(data);
  }

  function renderSrv(data) {
    srvThumbGen++;
    srvThumbQueue = [];
    srvThumbUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    srvThumbUrls = [];
    $("srvPath").textContent = "📁 " + (srvDir || "(ルート)");
    $("srvUp").style.display = srvDir ? "flex" : "none";
    var box = $("srvList");
    box.innerHTML = "";
    data.dirs.forEach(function (d) {
      var c = makeCard("📁", d.name);
      c.querySelector(".thumb").style.background = "#2e2216";
      c.onclick = function () { srvList(joinPath(srvDir, d.name)); };
      box.appendChild(c);
    });
    var zips = data.files.filter(function (it) { return it.kind === "zip"; });
    zips.forEach(function (it) {
      var rel = joinPath(srvDir, it.name);
      var c = makeCard("🗜", bookTitle(it.name));
      c.querySelector(".sub").textContent =
        (shelfNames[it.name] ? "✓取込済 ・ " : "") + fmtSize(it.size);
      c.onclick = function () { srvImport(rel, it.name); };
      box.appendChild(c);
      srvThumbQueue.push({ card: c, path: rel, gen: srvThumbGen });
    });
    if (!data.dirs.length && !zips.length) {
      var em = document.createElement("div");
      em.style.cssText = "opacity:.5;font-size:13px;padding:8px;grid-column:1/-1;text-align:center";
      em.textContent = "からっぽです";
      box.appendChild(em);
    }
    pumpSrvThumb();
  }

  // zip の先頭画像を HTTP Range で範囲読みしてサムネにする（直列・LAN前提）
  async function pumpSrvThumb() {
    if (srvThumbBusy) return;
    srvThumbBusy = true;
    while (srvThumbQueue.length) {
      var job = srvThumbQueue.shift();
      if (job.gen !== srvThumbGen) continue;
      try {
        var reader = new zip.ZipReader(new zip.HttpRangeReader(srvUrl + "/zips/" + encPath(job.path)));
        var entries = await reader.getEntries();
        var first = null;
        for (var i = 0; i < entries.length; i++) {
          var en = entries[i];
          if (!en.directory && IMG_RE.test(en.filename) && !/(^|\/)__MACOSX\//.test(en.filename)) {
            if (!first || naturalCmp(en.filename, first.filename) < 0) first = en;
          }
        }
        if (first && job.gen === srvThumbGen) {
          var blob = await first.getData(new zip.BlobWriter());
          var u = URL.createObjectURL(blob);
          srvThumbUrls.push(u);
          var th = job.card.querySelector(".thumb");
          if (th) { th.textContent = ""; th.style.backgroundImage = "url('" + u + "')"; }
        }
        await reader.close();
      } catch (e) { /* このzipはサムネ無しでスキップ */ }
    }
    srvThumbBusy = false;
  }

  async function srvImport(rel, name) {
    if (shelfNames[name] && !confirm("「" + bookTitle(name) + "」は既にあります。上書きしますか？")) return;
    if (!canWrite()) {
      alert("このブラウザは端末内保存(createWritable)に未対応です。\niOS 18.2 以降 / 最新の Safari・Chrome で使えます。");
      return;
    }
    $("loading").style.display = "flex";
    $("loadTxt").textContent = "DL中 : " + name;
    try {
      var root = await opfsRoot();
      var res = await fetch(srvUrl + "/zips/" + encPath(rel), { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var total = parseInt(res.headers.get("Content-Length"), 10) || 0;
      var fh = await root.getFileHandle(name, { create: true });
      var w = await fh.createWritable();
      try {
        if (res.body) {
          // ストリームで直接 OPFS へ（メモリに全量を持たない）
          var rd = res.body.getReader();
          var got = 0;
          for (;;) {
            var r = await rd.read();
            if (r.done) break;
            await w.write(r.value);
            got += r.value.byteLength;
            if (total) $("loadTxt").textContent = "DL中 : " + name + " (" + Math.round(got / total * 100) + "%)";
          }
        } else {
          await w.write(await res.blob());   // ストリーム非対応環境の保険
        }
        await w.close();
      } catch (e) {
        try { await w.abort(); } catch (e2) {}
        throw e;
      }
      $("loadTxt").textContent = "サムネ作成中 : " + name;
      var saved = await (await root.getFileHandle(name)).getFile();
      var tb = await makeThumb(saved);
      if (tb) {
        var td = await thumbsDir(true);
        var th = await td.getFileHandle(thumbName(name), { create: true });
        var tw = await th.createWritable();
        await tw.write(tb);
        await tw.close();
      }
      meta[name] = { added: Date.now(), size: saved.size, pos: 0, total: 0 };
      saveMeta();
      shelfNames[name] = 1;
      toast("取込完了: " + bookTitle(name));
      srvList(srvDir);   // ✓表示を更新
    } catch (e) {
      console.error(e);
      alert("取込失敗: " + name + "\n" + e.message);
    }
    $("loading").style.display = "none";
  }

  // ---- 本を開く ----
  async function openBook(name) {
    $("start").style.display = "none";
    $("loading").style.display = "flex";
    $("loadTxt").textContent = "目次を読み込み中 : " + name;
    clearCache();
    slides = [];
    curBook = "";
    try {
      var root = await opfsRoot();
      var fh = await root.getFileHandle(name);
      var file = await fh.getFile();
      // BlobReader = zip 全体を一括ロードせず、必要な範囲だけ読む
      var reader = new zip.ZipReader(new zip.BlobReader(file));
      var entries = await reader.getEntries();   // 末尾の目次だけ読む＝ほぼ一瞬
      var imgs = [];
      for (var i = 0; i < entries.length; i++) {
        var en = entries[i];
        if (!en.directory && IMG_RE.test(en.filename) && !/(^|\/)__MACOSX\//.test(en.filename)) {
          imgs.push(en);
        }
      }
      imgs.sort(function (a, b) { return naturalCmp(a.filename, b.filename); });
      for (var j = 0; j < imgs.length; j++) {
        // ここでは展開しない。表示時にその画像のバイト範囲だけ取り出す
        slides.push({ name: imgs[j].filename, entry: imgs[j] });
      }
    } catch (e) {
      console.error(e);
      $("loading").style.display = "none";
      alert("読み込み失敗: " + name);
      $("start").style.display = "flex";
      return;
    }
    curBook = name;
    finalizeLoad();
  }

  function finalizeLoad() {
    $("loading").style.display = "none";
    if (!slides.length) {
      alert("画像が見つかりませんでした。");
      $("start").style.display = "flex";
      curBook = "";
      return;
    }
    buildOrder();
    pos = 0;
    // 読書位置を復元（最後まで読んでいた本は先頭から）
    var m = curBook ? meta[curBook] : null;
    if (m) {
      m.total = slides.length;
      var sv = m.pos | 0;
      if (sv > 0 && sv < slides.length - 1) {
        var p = order.indexOf(sv);
        if (p >= 0) pos = p;
      }
      saveMeta();
    }
    pic.style.display = "block";
    ctrl.style.display = "flex";
    topbar.style.display = "flex";
    $("bookTitle").textContent = bookTitle(curBook);
    show();
    pause();   // 初期は自動再生オフ（▶で開始）
    // 開いた直後はUIを隠す（中央タッチで表示）
    setBars(false);
    info.classList.add("hidden");
  }

  function backToShelf() {
    pause();
    ++showToken;               // 進行中の表示を破棄
    pic.style.display = "none";
    pic.removeAttribute("src");
    ctrl.style.display = "none";
    topbar.style.display = "none";
    $("settings").classList.add("hidden");
    clearCache();
    slides = []; order = []; curBook = "";
    $("start").style.display = "flex";
    renderShelf();
  }

  function buildOrder() {
    order = slides.map(function (_, i) { return i; });
    if (shuffle) {
      for (var i = order.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = order[i]; order[i] = order[j]; order[j] = t;
      }
    }
  }

  // ---- 表示 ----
  // 表示中の前後だけ展開して保持。遠い画像は解放する
  function getURL(idx) {
    if (urlCache[idx]) return Promise.resolve(urlCache[idx]);
    return slides[idx].entry.getData(new zip.BlobWriter()).then(function (blob) {
      urlCache[idx] = URL.createObjectURL(blob);
      return urlCache[idx];
    });
  }
  function evict(keep) {
    Object.keys(urlCache).forEach(function (k) {
      if (keep.indexOf(parseInt(k, 10)) < 0) {
        URL.revokeObjectURL(urlCache[k]);
        delete urlCache[k];
      }
    });
  }
  function clearCache() {
    Object.keys(urlCache).forEach(function (k) { URL.revokeObjectURL(urlCache[k]); });
    urlCache = {};
  }

  function show() {
    if (!order.length) return;
    var token = ++showToken;
    var idx = order[pos];
    info.textContent = (pos + 1) + " / " + order.length;
    syncSeek();
    flashInfo();
    updateGauge();   // 新しい画像ごとにカウントダウンを巻き戻す
    // 読書位置を保存（ページをめくるたび）
    if (curBook && meta[curBook]) { meta[curBook].pos = idx; saveMeta(); }
    getURL(idx).then(function (url) {
      if (token !== showToken) return;   // 別の表示が始まっていれば破棄
      pic.src = url;
      // 前後を先読み＋それ以外は解放（メモリは数枚分だけ）
      var keep = [idx];
      var ni = (pos + 1 < order.length) ? order[pos + 1] : (loop ? order[0] : -1);
      var pi = (pos - 1 >= 0) ? order[pos - 1] : (loop ? order[order.length - 1] : -1);
      if (ni >= 0) keep.push(ni);
      if (pi >= 0) keep.push(pi);
      evict(keep);
      if (ni >= 0) getURL(ni).catch(function () {});   // 次を先読み（失敗は無視）
    }).catch(function (e) { console.error(e); });
  }

  function syncSeek() {
    var seek = $("seek");
    seek.max = Math.max(0, order.length - 1);
    seek.value = pos;
    $("seekLbl").textContent = (pos + 1) + " / " + order.length;
  }

  var infoTimer = null;
  function flashInfo() {
    if (barsVisible()) return;   // バー表示中は下バーの n/N と重複するので出さない
    info.classList.remove("hidden");
    clearTimeout(infoTimer);
    infoTimer = setTimeout(function () { info.classList.add("hidden"); }, 1500);
  }

  function next(byUser) {
    if (pos + 1 >= order.length) {
      if (loop) { pos = 0; if (shuffle) { buildOrder(); } }
      else { pause(); return; }
    } else { pos++; }
    show();
    if (byUser && playing) restartTimer();
  }

  function prev() {
    if (pos === 0) { pos = loop ? order.length - 1 : 0; }
    else { pos--; }
    show();
    if (playing) restartTimer();
  }

  // ---- 再生制御 ----
  function intervalMs() { return parseInt($("speed").value, 10) * 100; }

  function restartTimer() {
    clearInterval(timer);
    timer = setInterval(function () { next(false); }, intervalMs());
  }

  // ---- カウントダウンゲージ ----
  function startGauge() {
    var g = $("gaugeFill");
    g.style.transition = "none";
    g.style.width = "0%";
    void g.offsetWidth;   // リフローして巻き戻しを確定
    g.style.transition = "width " + intervalMs() + "ms linear";
    g.style.width = "100%";
  }
  function stopGauge() {
    var g = $("gaugeFill");
    g.style.transition = "none";
    g.style.width = "0%";
  }
  function updateGauge() {
    if (gaugeOn && playing) { $("gauge").style.display = "block"; startGauge(); }
    else { $("gauge").style.display = "none"; stopGauge(); }
  }

  function play() {
    playing = true;
    $("playBtn").textContent = "⏸";
    restartTimer();
    updateGauge();
    requestWake();
    setTimeout(function () { if (playing) setBars(false); }, 1800);
  }

  function pause() {
    playing = false;
    $("playBtn").textContent = "▶";
    clearInterval(timer);
    updateGauge();
    releaseWake();
    setBars(true);
  }

  function togglePlay() { playing ? pause() : play(); }

  // ---- 画面スリープ防止（https 配信なので有効）----
  async function requestWake() {
    try {
      if ("wakeLock" in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", function () { wakeLock = null; });
      }
    } catch (e) { /* 非対応 */ }
  }
  function releaseWake() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && playing) requestWake();
  });

  // ---- 操作 ----
  $("openBtn").onclick = function () { $("picker").click(); };
  $("picker").onchange = function (e) {
    importFiles(e.target.files);
    e.target.value = "";   // 同じファイルを再選択できるように
  };
  $("backBtn").onclick = backToShelf;                // ◁ 戻る = 本棚へ
  $("srvBtn").onclick = openSrv;
  $("srvClose").onclick = closeSrv;
  $("srvReload").onclick = function () { srvList(srvDir); };
  $("srvUp").onclick = function () {
    var parent = srvDir.indexOf("/") >= 0 ? srvDir.slice(0, srvDir.lastIndexOf("/")) : "";
    srvList(parent);
  };
  $("srvCfg").onclick = function () { if (askSrvUrl()) srvList(srvDir); };
  $("sortName").onclick = function () { setSort("name"); };
  $("sortDate").onclick = function () { setSort("date"); };
  $("editBtn").onclick = function () {
    editing = !editing;
    $("editBtn").textContent = editing ? "完了" : "編集";
    $("editBtn").classList.toggle("on", editing);
    $("shelfList").classList.toggle("editing", editing);
  };

  $("playBtn").onclick = togglePlay;
  $("nextBtn").onclick = function () { next(true); };
  $("prevBtn").onclick = prev;

  $("loopBtn").onclick = function () {
    loop = !loop; $("loopBtn").classList.toggle("on", loop);
    localStorage.setItem("zsh_loop", loop ? "1" : "0");
  };
  $("shufBtn").onclick = function () {
    shuffle = !shuffle; $("shufBtn").classList.toggle("on", shuffle);
    localStorage.setItem("zsh_shuf", shuffle ? "1" : "0");
    if (slides.length) {
      var cur = order[pos];
      buildOrder();
      pos = shuffle ? 0 : order.indexOf(cur);
      if (pos < 0) pos = 0;
      show();
    }
  };
  $("rtlBtn").onclick = function () {
    rtl = !rtl; $("rtlBtn").classList.toggle("on", rtl);
    localStorage.setItem("zsh_rtl", rtl ? "1" : "0");
    applyRtl();
  };
  $("gaugeBtn").onclick = function () {
    gaugeOn = !gaugeOn; $("gaugeBtn").classList.toggle("on", gaugeOn);
    localStorage.setItem("zsh_gauge", gaugeOn ? "1" : "0");
    updateGauge();
  };

  $("speed").oninput = function () {
    $("spdLbl").textContent = ($("speed").value / 10).toFixed(1) + " 秒";
    localStorage.setItem("zsh_speed", $("speed").value);
    if (playing) { restartTimer(); startGauge(); }
  };

  // 右から左へ読む（シークバーの向きを反転）
  function applyRtl() { $("seek").style.direction = rtl ? "rtl" : "ltr"; }

  // シークバー（位置スクラブ）
  $("seek").oninput = function () {
    pos = parseInt($("seek").value, 10) || 0;
    show();
    if (playing) restartTimer();
  };

  // 設定パネル（⚙）
  $("gearBtn").onclick = function () { $("settings").classList.remove("hidden"); };
  $("setClose").onclick = function () { $("settings").classList.add("hidden"); };
  $("settings").onclick = function (e) {
    if (e.target === $("settings")) $("settings").classList.add("hidden");
  };

  // タップ領域（RTL時は左端で進む）。頁を切り替えたらツールバーは閉じる
  $("zoneL").onclick = function () { setBars(false); rtl ? next(true) : prev(); };
  $("zoneR").onclick = function () { setBars(false); rtl ? prev() : next(true); };
  $("zoneC").onclick = function () { setBars(!barsVisible()); };

  // スワイプ
  var sx = 0, sy = 0;
  $("stage").addEventListener("touchstart", function (e) {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  $("stage").addEventListener("touchend", function (e) {
    var dx = e.changedTouches[0].clientX - sx;
    var dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      setBars(false);   // 頁切替でツールバーを閉じる
      // RTL: 右スワイプで進む（左から次ページが現れる）
      var goNext = rtl ? (dx > 0) : (dx < 0);
      goNext ? next(true) : prev();
    }
  }, { passive: true });

  // ダブルタップ拡大などの誤爆防止
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });

  // 起動時：保存済み設定をUIに反映
  $("loopBtn").classList.toggle("on", loop);
  $("shufBtn").classList.toggle("on", shuffle);
  $("rtlBtn").classList.toggle("on", rtl);
  $("gaugeBtn").classList.toggle("on", gaugeOn);
  $("speed").value = localStorage.getItem("zsh_speed") || "30";
  $("spdLbl").textContent = ($("speed").value / 10).toFixed(1) + " 秒";
  applyRtl();

  // 起動時：オフライン起動用 SW 登録＋ストレージ永続化を要求＋本棚描画
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function () {});
  }
  try {
    // 許可されるとストレージ逼迫時の自動削除対象から外れやすくなる（非対応は無視）
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  } catch (e) {}
  updateSortUI();
  renderShelf();
})();
