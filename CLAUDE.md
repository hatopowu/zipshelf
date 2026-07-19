# ZipShelf

zip / cbz / pdf を **iPhone/iPad の端末内(OPFS)に保存**し、**オフラインでも自動スライドショー(カウントダウンゲージ付き)で読める**個人用 PWA。
[ZipSlide](../ZipSlide/CLAUDE.md) のフォーク。役割分担 = **ZipSlide は LAN ストリーミングで「今すぐ見る」／ZipShelf は端末保存で「持ち歩いて見る」**。Sidebooks 的な多機能リーダーは目指さない(本棚＋自動送りだけ)。

## 構成
- `index.html` … 画面構造 + CSS。アクセント色はオレンジ `--acc:#f08c3a`(ZipSlide の青と区別)。
- `app.js` … 全ロジック。ビューア中核(遅延展開・前後先読み・RTL)は ZipSlide と同一、ソース層だけ OPFS。カウントダウンは ZipSlide の下端バーと違い右下の小型 SVG リング(26px・白50%+暗円盤背景)。
- `sw.js` … Service Worker。ネットワーク優先＋失敗時キャッシュ=オフライン起動用。**ASSETS を増減したら VER を上げる**。
- `zip.min.js` … @zip.js/zip.js 2.7.45 をローカル同梱(CDN 不使用=完全オフライン対応)。
- `pdf.min.js` / `pdf.worker.min.js` … pdf.js 3.11.174(UMD版)をローカル同梱。**PDF を開く時だけ動的 script 挿入で読み込む**(ensurePdfjs)。SW の ASSETS に入れてあるのでオフラインでも初回から動く。ESM 版(4.x/5.x の .mjs)にしないのは app.js が非モジュールの素スクリプトだから。
- `manifest.webmanifest` / `icon.svg` / `apple-touch-icon.png` … PWA 用。
- `start-server.bat` … 動作確認用サーバ。**ZipSlide の `serve.py` を共用**(このフォルダにコピーは置かない)。`ZIPSLIDE_APP_DIR=%~dp0` で配信ルートを ZipShelf に向け、ポートは 8010/8453 にずらして ZipSlide 本体と同時起動できるようにしてある。

## 大前提: HTTPS 必須
OPFS・Service Worker・wakeLock はすべて **secure context(https か localhost)必須**。
- **本番 = GitHub Pages 等の https 静的ホスティング**(公開されるのはアプリコードのみ。zip データは端末内に留まる)。
- http 配信では動かない。http で開くと本棚の代わりに警告バナー(#nossl)が出る。
- **PC 確認 = `http://localhost:8010/`**(`start-server.bat`)。localhost は http でも secure context 扱いなので証明書が要らない。同じ http でも `http://<PCのIP>:8010/` は secure context にならず #nossl になるので注意。
- **iPad 実機確認 = `https://<PCのIP>:8453/`**(同じ `start-server.bat`。cert.pem がある時のみ開く。証明書は ZipSlide の `gen-cert.ps1` 生成物を共用、iPad 側の導入手順はサーバ取込と同じ)。GitHub Pages に push しなくても実機検証できる。
- **PC のブラウザで https:8453 を開くと自己署名証明書の警告が出る**(Firefox の「異常な動作をしている可能性があります」等)。正常＝自分の証明書が公的 CA 署名でないだけ。**Firefox は Windows の証明書ストアを見ない独自ストアなので、iPad と同じ証明書を Windows に入れても消えない**。PC では素直に localhost:8010 を使う。どうしても https を見たいなら例外追加(`127.0.0.1` ではなく SAN と一致する LAN IP で開くこと)。

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
- サーバ URL は初回 prompt で入力し localStorage `zsh_srv` に保存(「URL」ボタンで変更)。既定値は **serve.py 自身から開いていれば `location.origin`**(= `location.port` があるかで判定)。
- **https 必須なのはページ自体が https の時だけ**(混在コンテンツ)。ページが http(PC の localhost 確認)なら http の URL も許可する。
- **PC 確認の地雷**: `http://localhost:8010/` から `https://<LANのIP>:8453` を叩くと、**PC の信頼ストアに自己署名証明書が無いので fetch が即失敗**する(→「サーバに接続できません」)。トップレベル遷移と違い**ページ内 fetch は警告画面を出せない＝「詳細設定→アクセスする」で通す機会が無い**。対処は下記のどれか(実測: 同一オリジン http=200 / cert検証あり=接続失敗)。
  1. **「URL」ボタンで `http://localhost:8010` に変える**(同一オリジン＝証明書不要。PC 確認はこれが一番早い。接続失敗の alert にもこの案内を出している)
  2. 先に `https://192.168.11.15:8453/` をブラウザで直接開いて警告を通しておく(オリジン毎・ブラウザ毎に必要。Firefox は Windows の証明書ストアを見ないので独自に例外登録が要る)
  - iPad は証明書プロファイルを導入済みなのでこの問題は出ない。
- ブラウズ: `GET /list?dir=` でフォルダナビ(zip と pdf を表示・動画は無視)。サムネは zip.js HttpRangeReader で先頭画像を範囲読み(直列キュー・世代カウンタで打ち切り)。✓取込済み表示は本棚の名前一致。
- ヘッダーは2段: 上段=⬆ + パス + URL + ⟳ + ✕、下段=**🔍絞り込み + 名前/日付ソート**(`srvSortKey`/`srvSortAsc` = localStorage `zsh_srvSort*`、本棚のソートとは独立)。`srvData` に `/list` の結果を保持し、ソート・絞り込みは再取得せず再描画。絞り込みは**フォルダ移動で自動解除**(⟳では保持)、入力は 150ms デバウンス(除外されたカードはサムネキューに積まない)。
- DL: fetch → `res.body.getReader()` で OPFS createWritable にストリーム書き(全量をメモリに持たない・進捗%)。保存後は OPFS の実体から makeThumb(ピッカー取込と同じ経路)。

## PDF 対応
- ソース層だけ分岐し、ビューア(自動送り・RTL・先読み・ゲージ)は zip と完全共通。`slides[i]` が zip = `{name, entry}` / pdf = `{name, page}`、`getURL()` が「zip なら範囲展開・pdf なら該当ページを canvas 描画→jpeg blob」を吸収する。
- 描画解像度は `viewPx()` = 画面長辺×dpr(上限2400px)。**iOS の canvas 面積上限 16M px を超えると真っ白になる**ので `MAX_CANVAS_PX` で縮小する。PDF の背景は透明なので描画前に白で塗り潰す(でないと暗所モードで黒地に黒文字)。
- 本棚サムネは 1 ページ目を同じ経路で 320px 描画(makePdfThumb)。カードのアイコンは pdf=📕 / zip=🗜。
- **pdf.js は zip のような遅延読みができず本体を丸ごとメモリに載せる**(openBook で arrayBuffer)。数百MBの PDF は避ける想定。ページ画像側は従来通り前後だけキャッシュ。
- 本を閉じる/開き直す時は `closePdf()` で `PDFDocumentProxy.destroy()`(worker 解放)。
- サーバ取込(🌐)も pdf 可(serve.py 側に `kind:"pdf"` を追加済み)。**pdf は zip と違い HTTP Range で先頭ページだけ抜くことができない**ので、一覧のサムネは serve.py の `/thumb`(Windows シェル=エクスプローラーと同じ絵)を借りる。取込後の本棚サムネは通常どおり端末側で 1 ページ目を描画。

## ビューア(ZipSlide と共通の作法)
- zip 全体を展開しない: BlobReader で目次だけ読み、表示時に該当画像のバイト範囲だけ取り出す。前後1枚先読み・離れた画像は revokeObjectURL(showToken で競合ガード)。
- RTL 既定・タップ3分割・スワイプ・シークバー・⚙設定(RTL/ループ/シャッフル/ゲージ/ゲージ位置右下⇔左下/ゲージ濃さ30〜100%/秒数、localStorage `zsh_*`)・カウントダウンゲージ・wakeLock。
- UI は上下ツールバー(setBars でペア切替): 上=「◁戻る」+ファイル名(省略表示)+⚙、下=シークバー+⏮▶⏭。中央タップでトグル、左右タップ/スワイプの頁切替で閉じる。バー表示中は上部の n/N オーバーレイ(#info)を出さない(下バーのラベルが兼ねる)。
- 本棚: サムネグリッド+進捗(n/total)+サイズ表示、「編集」トグルまたはカード長押し(550ms, iOSホーム画面風)で編集モード→✕削除(confirm)・「完了」or背景タップで解除、ストレージ使用量表示。ヘッダーは2段: 上段=📚N冊 + 編集、下段=**🔍絞り込み + 名前/追加日ソート**(既定=追加日新しい順)。
- **🔍絞り込み**(本棚・サーバ取込で共通): 小文字化＋空白区切りの AND 部分一致(`matchName`)。永続しない。iOS 対策として入力の `font-size` は **16px 必須**(未満だとフォーカス時に画面が拡大)、`.filt` で body の `user-select:none` を打ち消す(でないとキャレットが出ない)、ネイティブの検索クリアボタンは消して自前の ✕ に一本化。
  - 本棚側は**再描画せずカードの display を切り替えるだけ**(`applyShelfFilter`。renderShelf は OPFS 再読込＋サムネ作り直しが走るので毎キーストロークで呼ばない)。カードに `dataset.name` を持たせて判定。冊数ラベルは絞り込み中「📚 3 / 12冊」表示、0件は #shelfEmpty を「該当なし」に差し替え。

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
