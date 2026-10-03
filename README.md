# 画像つなぎ LargePic

スクロールした画面（地図アプリなど）を**画面収録 / スクリーンショット**から自動でつなぎ合わせ、**1枚の大きな画像**として保存するアプリ。
Web アプリ（PWA）として動き、Capacitor で **Android / iOS のネイティブアプリ**（Play ストア / App Store 公開用）にもなります。画像はすべて端末内で処理され、送信しません。

## できること

- **撮影ボタン** → 画面収録を開始（ネイティブ版：アプリ内ボタン / Web 版：OS の画面収録 → 動画を選択 / PC：ライブ取り込み）
- 収録動画は**2段階**で取り込み：①縮小画像で動画全体のスクロール経路をざっと解析（再生しながら高速に）→ ②**前のコマと十分重なる、止まったコマ（キーフレーム）だけ**を高解像度で位置合わせして連結。全コマを調べる方式の約4倍速（解析に失敗したら全コマ方式に自動で切り替え）
- **赤い斜線 = まだ埋まっていない範囲**。［不足部分を追加撮影］で追加の動画を撮ると、取り込み済みの場所を目印に位置を合わせて埋まる
- 作業内容は端末内に**自動保存**（撮影のため他アプリへ切り替えても続きから再開）
- 保存時のトリミング：**四角 / 丸** × **外接 / 内接 / 自由**（ドラッグで調整）
- **分割保存**：端末のキャンバス上限（iPhoneは約1,670万画素）を超える大きさでも、**画質そのまま**（PNGタイル）で保存できる。ZIPの中に、地図アプリのようなタイルのピラミッド（`L0/` 元の解像度、`L1/…` 縮小）と `manifest.json` が入る。ビューアは見えている範囲のタイルだけを読むので、巨大な画像も継ぎ目なく拡大縮小できる
- **保存した画像の一覧（［🔍 閲覧］の入口）**：書き出すたびに、この端末のライブラリへ自動で入る（サムネイル付き・新しい順）。［閲覧］を押すとまずこの一覧が開き、タップでビューアに。保存（ダウンロード）・削除もここから。別の場所のファイルは［ファイルから開く］
- **ビューア**：保存した大きな画像を地図のように拡大縮小して見られる（ドラッグ・ピンチ・ホイール・ダブルタップ・慣性、等倍/全体ボタン）。巨大な画像でも縮小画像から描くので軽い
- **矛盾の検出と取り消し**：取り込み中に、すでに取り込んだ部分と絵が食い違うと自動で一時停止（直前3枚を取り消す／この取り込み分をすべて取り消す／残して終了／無視して続ける）。［↶ 戻す］で1枚・5枚・取り込み単位で取り消せる
- **つながらなくなったら止める**：取り込み済みの場所と画像がつながらなくなる（位置を見失い続ける）と一時停止し、［一つ前に戻して保存へ］［ここまでを残して保存へ］［続ける］［取り消して終了］を選べる
- **裏に回っても止まりにくい**：処理中は画面を消さない（Wake Lock）。裏のタブで間引かれない待ち方（MessageChannel / Worker タイマー）。取り込みの途中経過（動画・選んだコマ・進み具合）を端末に残し、ブラウザがページを止めても、戻ったときに**続きから再開**できる。タブの名前に進み具合（％）を表示、終了時の通知（任意）
  - 限界：ブラウザの仕様で、iPhone/Android のブラウザは別のアプリに切り替えて少し経つとページを止める（Android の専用アプリ版の前面サービスで改善する余地あり）。止まった場合は上の「続きから再開」で戻れる
- 撮影のコツ・使い方ヘルプ内蔵

## 構成

```
www/                 Web アプリ本体（ビルド不要の静的ファイル）
  js/register.js       位置合わせ（位相相関 FFT → NCC → 1px 精度）
  js/stitcher.js       タイル配置・動画追跡（Tracker）
  js/mosaic.js         タイル集合・書き出し
  js/trim.js           内接/外接/自由 トリミング
  js/store.js          IndexedDB 自動保存
  js/native.js         ネイティブ（Capacitor）橋渡し
android/             Android（ScreenRecorder プラグイン：MediaProjection + 前面サービス）
ios/                 iOS（ScreenRecorder プラグイン + ReplayKit 拡張の手順は下記）
resources/           アイコン元画像・生成スクリプト・ストア用画像
test/                単体テスト・ブラウザ通し試験
```

## 開発

```sh
npm install
npm start            # http://localhost:8000
npm test             # 位置合わせの単体テスト
npm run test:e2e     # Playwright 通し試験（スクショ/動画/追加動画/トリミング/自動保存）
npm run icons        # resources/icon-source.jpg から全アイコン・スプラッシュ・ストア画像を再生成
```

## Android（Play ストア）

必要：Android Studio（または Android SDK + JDK 17+）

```sh
npm install
npx cap sync android
npx cap open android          # Android Studio で開く → ▶ で実機実行
```

- 録画：［● 録画を開始］→ 許可ダイアログ → ホームに戻って地図で撮影 → 通知の［停止して取り込む］（またはアプリに戻って停止）
- **公開**：Android Studio の *Build > Generate Signed App Bundle* で `.aab` を作成し Play Console へ。`applicationId` は `com.fuuchanlab.largepic`（`capacitor.config.json` と `android/app/build.gradle`。変更するなら両方＋`MainActivity` のパッケージ）。
- ストア素材：`resources/store/play-icon-512.png`（アイコン）、`feature-graphic-1024x500.png`（フィーチャー画像）
- 権限の申告：Play Console の「フォアグラウンド サービス（mediaProjection）」宣言で、用途＝「ユーザーが開始した画面収録を地図画像の作成に使う」と記載。

## iOS（App Store）

必要：Mac + Xcode 15 以上、Apple Developer アカウント

iOS は他アプリの画面を録画できるのが **ReplayKit のブロードキャスト拡張**だけのため、Xcode で拡張ターゲットを1つ追加します（雛形は `ios/App/LargePicBroadcast/` に用意済み）。

```sh
npm install
npx cap sync ios
npx cap open ios
```

1. **File > New > Target > Broadcast Upload Extension** を選び、名前 `LargePicBroadcast`、*Include UI Extension* は**オフ**、Bundle Identifier は `com.fuuchanlab.largepic.Broadcast`。
2. 自動生成された `SampleHandler.swift` / `Info.plist` を、`ios/App/LargePicBroadcast/` の同名ファイルの内容で置き換え（またはそのファイルをターゲットに追加）。
3. **App と LargePicBroadcast の両ターゲット**で *Signing & Capabilities > + Capability > App Groups* を追加し、`group.com.fuuchanlab.largepic` を有効化（Entitlements は `App/App.entitlements`・`LargePicBroadcast/LargePicBroadcast.entitlements`）。
4. 実機で実行 → ［● 録画を開始］→「LargePic」を選んで「ブロードキャストを開始」→ 地図アプリで撮影 → 画面上部の赤い表示から停止 → アプリに戻ると自動で取り込み。
5. **公開**：Product > Archive → App Store Connect。アイコンは `AppIcon-512@2x.png`（1024px）設定済み。

> Android の Capacitor は SPM ではなく Gradle、iOS は Swift Package Manager（CocoaPods 不要）です。

## 仕様メモ

- 平行移動のみ対応。撮影中の拡大縮小・回転があると位置が合いません（ヘルプに注意書きあり）。
- iPhone の書き出し上限は約 1,670 万画素。超える場合は自動で縮小サイズを提案します。
