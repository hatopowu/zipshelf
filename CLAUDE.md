# ZipShelf

zip / cbz を **iPhone/iPad の端末内(OPFS)に保存**し、**オフラインでも自動スライドショー(カウントダウンゲージ付き)で読める**個人用 PWA。
[ZipSlide](../ZipSlide/CLAUDE.md) のフォーク。役割分担 = **ZipSlide は LAN ストリーミングで「今すぐ見る」／ZipShelf は端末保存で「持ち歩いて見る」**。Sidebooks 的な多機能リーダーは目指さない(本棚＋自動送りだけ)。

## 構成
- `index.html` … 画面構造 + CSS。アクセント色はオレンジ `--acc:#f08c3a`(ZipSlide の青と区別)。
- `app.js` … 全ロジック。ビューア中核(遅延展開・前後先読み・RTL)は ZipSlide と同一、ソース層だけ OPFS。カウントダウンは ZipSlide の下端バーと違い右下の小型 SVG リング(白30%)。
- `sw.js` … Service Worker。ネットワーク優先＋失敗時キャッシュ=オフライン起動用。**ASSETS を増減したら VER を上げる**。
- `zip.min.js` … @zip.js/zip.js 2.7.45 をローカル同梱(CDN 不使用=完全オフライン対応)。
- `manifest.webmanifest` / `icon.svg` / `apple-touch-icon.png` … PWA 用。
- `start-dev.bat` … PC 確認用 `py -m http.server 8010 --bind 127.0.0.1`。

## 大前提: HTTPS 必須
OPFS・Service Worker・wakeLock はすべて **secure context(https か localhost)必須**。
- **本番 = GitHub Pages 等の https 静的ホスティング**(公開されるのはアプリコードのみ。zip データは端末内に留まる)。
- ZipSlide の serve.py(http)配信では動かない。http で開くと本棚の代わりに警告バナー(#nossl)が出る。
- PC 確認は `start-dev.bat` → `http://localhost:8010/`(localhost は secure context 扱い)。

## ストレージ設計
- 実体: OPFS ルート直下に zip 名そのままで保存。サムネは `thumbs/<zip名>.jpg`(取込時に先頭画像を長辺320px jpeg化)。
- メタ(追加日・読書位置 pos・総ページ total): localStorage `zsh_meta`。本棚描画時に実体と突き合わせて孤児メタを掃除。
- 取込 = ファイルピッカー → 8MB チャンクで createWritable に書く(進捗%表示)。close() で確定するので途中失敗で壊れた実体は残らない。同名は confirm で上書き。
- **createWritable は iOS 18.2+ / 最新ブラウザが必要**。未対応なら取込時に alert で案内。
- `navigator.storage.persist()` を起動時に要求(追い出されにくくする)。それでも **OPFS は OS に消される可能性がゼロではない**ので、原本は PC 側に残す運用が前提(消えたら再取込)。
- 読書位置はページめくり毎に slide index を保存。最終ページまで読んだ本は次回先頭から。

## サーバ取込（🌐 ボタン）
ZipSlide の serve.py(PC) から LAN 経由で zip を DL して本棚に保存する経路(取込のみ・ストリーミング閲覧はしない)。
- **serve.py 側の https ポート(既定8443)+CORS が前提**。GitHub Pages(https) → serve.py(http) は混在コンテンツでブロックされるため、自己署名証明書で https 化してある(ZipSlide の `gen-cert.ps1` で生成、iPad は初回に `http://<PCのIP>:8000/cert` から証明書を導入して信頼設定)。
- サーバ URL は初回 prompt で入力し localStorage `zsh_srv` に保存(「URL」ボタンで変更)。https 必須をバリデーション。
- ブラウズ: `GET /list?dir=` でフォルダナビ(zip のみ表示・動画は無視)。サムネは zip.js HttpRangeReader で先頭画像を範囲読み(直列キュー・世代カウンタで打ち切り)。✓取込済み表示は本棚の名前一致。
- DL: fetch → `res.body.getReader()` で OPFS createWritable にストリーム書き(全量をメモリに持たない・進捗%)。保存後は OPFS の実体から makeThumb(ピッカー取込と同じ経路)。

## ビューア(ZipSlide と共通の作法)
- zip 全体を展開しない: BlobReader で目次だけ読み、表示時に該当画像のバイト範囲だけ取り出す。前後1枚先読み・離れた画像は revokeObjectURL(showToken で競合ガード)。
- RTL 既定・タップ3分割・スワイプ・シークバー・⚙設定(RTL/ループ/シャッフル/ゲージ/秒数、localStorage `zsh_*`)・カウントダウンゲージ・wakeLock。
- UI は上下ツールバー(setBars でペア切替): 上=「◁戻る」+ファイル名(省略表示)+⚙、下=シークバー+⏮▶⏭。中央タップでトグル、左右タップ/スワイプの頁切替で閉じる。バー表示中は上部の n/N オーバーレイ(#info)を出さない(下バーのラベルが兼ねる)。
- 本棚: サムネグリッド+進捗(n/total)+サイズ表示、名前/追加日ソート(既定=追加日新しい順)、「編集」トグルまたはカード長押し(550ms, iOSホーム画面風)で編集モード→✕削除(confirm)・「完了」or背景タップで解除、ストレージ使用量表示。

## 検証
編集後は必ず: `node --check app.js` と `node --check sw.js`(構文チェック)。
GUI の見た目・使用感はビルド後にチェックポイントを列挙してユーザーに渡す(自動クリック検証はしない)。

## デプロイ(GitHub Pages)
1. このフォルダを GitHub リポジトリ(public)にpush → Settings > Pages > Deploy from branch。
2. iPhone/iPad Safari で `https://<user>.github.io/<repo>/` → 共有 > ホーム画面に追加。
3. 更新は push するだけ(SW がネットワーク優先なので次回起動で反映)。

## TODO / 拡張余地
- 見開き(2ページ)表示は不採用方針(Sidebooks 化しない)。
- 本棚のフォルダ分け・タグは必要になってから。
