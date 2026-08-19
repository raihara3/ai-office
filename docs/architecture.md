# アーキテクチャとファイル構成

本ドキュメントはコードベースの詳細な地図です。各ソースファイルとその役割を
記載します。アプリの概要や起動方法については [README](../README.md) を参照して
ください。

## 設計原則

アプリケーションの **core**(state + watchers + cleanup)は、いかなるトランスポートからも分離されています。
そのため同じロジックを、HTTP/SSEアダプタから駆動したり、Electron に組み込んだり、テストから直接動かしたりできます。
依存は内向き(inward)に向きます:

```
index.js → core.js → state.js / watchers/* / cleanup.js
http.js  → core.js(公開ハンドルのみ)
```

core 内のどのファイルもトランスポートを import しません。
外側との境界は `http.js` と `electron/main.js` だけです。

## データフロー

```
CLI セッションログ (JSONL)                   ブラウザ / Electron ウィンドウ
        │                                            ▲
        ▼                                            │ SSE スナップショット
 tail.js  ── 追記行 ──▶ watchers/*.js                │
                                     │ observations  │
                                     ▼               │
                                  state.js  ──▶  core.js  ──▶  http.js
                                  (sessions,        ▲
                                   #general log)    │ cleanup API
                                                cleanup.js
```

各 CLI は自身のセッショントランスクリプトを書き出します。`tail.js` は追記行を対応する watcher へ流し込み、watcher はそれをトランスポート非依存の*observation* にパースします。
`state.js` は observation をセッションごとの状態にマージし、表示ステータスを導出し、`#general` チャットログを保持します。
core はスナップショットをブロードキャストし、フロントエンドがそれを canvas とサイドバーへ描画します。

## ファイルツリー

```
server/                バックエンド(Node.js 標準ライブラリのみ)
  index.js             エントリポイント + startServer()(Electron 埋め込み契約も兼ねる)
  core.js              state + watchers + cleanup を合成; ライフサイクル(start/stop)
  http.js              HTTP 静的配信 + SSE + /api/* を core に橋渡しするアダプタ
  state.js             createState() ストア, deriveStatus()(純粋), #general ログ
  state.test.js        ストア + ステータス導出のテスト
  tail.js              汎用 JSONL 追従(fs.watch + 定期再スキャンのフォールバック)
  cleanup.js           createCleanup(): 終了済みセッション検出(ps + lsof)
  cleanup.test.js      人事(HR)退勤ヒューリスティックのテスト
  watchers/
    claude.js          Claude Code トランスクリプト解析(handleLine + startWatcher)
    codex.js           Codex CLI rollout ログ解析
    gemini.js          Gemini CLI チャットログ解析
    watchers.test.js   3 つの watcher の行パーステスト
public/                フロントエンド(静的 ES モジュールとして配信)
  index.html           マークアップ: canvas + #general サイドバー
  style.css            canvas ラッパとチャットパネルのスタイル
  office.js            canvas 描画ループ(部屋・デスク・アバター・吹き出し)
  office/
    specs.js           ベンダー別アバターの色 + エンブレム
    layout.js          純粋なシーン幾何(デスク・休憩スポット・座席)
    layout.test.js     幾何のテスト
    small-talk.js      休憩室の雑談ステートマシン(random 注入可能)
    small-talk.test.js 雑談のテスト
  office-client.js     トランスポートクライアント(SSE + cleanup API), IPC へ差し替え可能
  app.js               チャット描画・メンションチャイム・サイドバー composer
electron/              デスクトップラッパ
  main.js              Electron main: サーバを埋め込みウィンドウを開く
  preload.js           将来の IPC トランスポート用プレースホルダ
docs/
  architecture.md      本ファイル
README.md              概要・使い方・ステータスルール・制限事項
package.json           npm スクリプト(start/test/electron/dist) + electron-builder 設定
```

テストは対象コードの隣(`*.test.js`)に置かれ、`node --test` がその場で発見します。
Electron ビルドでは `package.json` の `!**/*.test.js` によって配布物から除外されます。

## バックエンド(`server/`)

### `index.js`

エントリポイント。`public/` ディレクトリを解決し、core と HTTP/SSE サーバを
生成して待ち受けを開始します(デフォルトポート `4680`、`PORT` で上書き可能)。
`startServer` を export し、これは Electron メインプロセスが呼び出す埋め込み契約
でもあります。

### `core.js`

state ストア・人事 cleanup・3 つの CLI watcher を、トランスポート非依存の 1 つの
ハンドル(`start`/`stop`、`subscribe`、`getSnapshot`、`postMessage`、
`previewCleanup`、`runCleanup`)に合成します。リフレッシュタイマーを保持し、
経過時間のみで起きる `working → break` の遷移もクライアントへ届くようにします。

### `http.js`

HTTP/SSE トランスポートアダプタ。静的 UI を配信し、状態スナップショットを
Server-Sent Events(`/events`)でストリームし、人事 cleanup のエンドポイント
(`GET /api/cleanup/preview`、`POST /api/cleanup`)を公開します。ドメインロジックは
すべて core にあり、本ファイルは配管(plumbing)に徹します。

### `state.js`

セッション状態ストア。`createState()` はクロックを注入可能な独立インスタンスを
返します。watcher は observation を `reportEvent` に流し込み、これは小さな純粋
ヘルパー群の上に構築された読みやすいパイプラインです:

- `createSession` — 新規セッションの雛形。
- `applyTiming` / `applyFields` / `applyTurnState` / `applySubagents` /
  `applyMcpCall` — observation の 1 側面を変異(mutation)で適用。クロックや I/O を
  持たないため、ストアは決定的に保たれます。
- `isDismissed` — 人事 cleanup が残す tombstone(墓標)を尊重します。
- `updateGeneralChannel` — 状態遷移に応じて `#general` メッセージ(依頼、🫡 の
  受領リアクション、完了 / 確認依頼の返信)を投稿します。

`deriveStatus(session, now)` は独立した純粋関数として export され、セッションと
現在時刻を `working` / `break` / `blocked` / `waiting` にマップします。

### `tail.js`

ディレクトリツリーに対する汎用 JSONL 追従。パターンに一致する最近更新された
ファイルを発見し、追記行をコールバックへストリームします。即応性のための
`fs.watch` に加え、定期再スキャンをフォールバックとして併用します(`fs.watch` は
macOS でイベントを取りこぼすことがあるため)。3 つの watcher が共有します。

### `cleanup.js`

人事 cleanup。`createCleanup()` は state インスタンスに加え、OS 検査関数
(プロセス一覧・オープンファイル・ファイル存在・ゴミ箱)を注入として受け取る
ため、退勤ヒューリスティックを実プロセスに触れずに単体テストできます。実行中の
プロセスは (CLI, 作業ディレクトリ) ごとに 1 つの「席」を付与し、直近に活動した
セッションのみが席を保持、残りは退勤対象となります。`working` 表示中の
セッションは決して退勤させず、曖昧なケースは「生存」側に倒します。

### `watchers/`

各 watcher は、注入された `report` コールバック(スタブでテスト可能)を通じて
observation を発行する準純粋(pure-ish)な `handleLine(entry, filePath, report)` と、
それを `tail.js` および実ストアに配線する `startXWatcher` を export します。

- **`claude.js`** — Claude Code トランスクリプト(`~/.claude/projects/**/*.jsonl`):
  `cwd`、`isSidechain`(サブエージェント)、`tool_use` ブロックを含む user/assistant
  行。`handleSubagentEnd` も export します。
- **`codex.js`** — Codex rollout ログ
  (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`): `session_meta`、タスクの
  開始/完了イベント、ユーザーメッセージ、`function_call` のツールアクション
  (MCP ツールを含む)。
- **`gemini.js`** — Gemini チャットログ
  (`~/.gemini/tmp/<project>/chats/session-*.jsonl`): メタデータと `$set` 状態
  パッチ。メッセージ形状はバージョン間で変わるため、JSON を汎用的に走査する
  ベストエフォート実装です。

## フロントエンド(`public/`)

ES モジュールとしてドキュメント順に読み込まれます:`office.js`(`window.OFFICE` を
設定)、`office-client.js`(`window.OFFICE_CLIENT` を設定)、`app.js`(両者を利用)。

### `index.html`

マークアップ:`<canvas>` と `#general` サイドバー(チャット一覧・cleanup
composer・接続インジケータ)。

### `style.css`

オフィス canvas ラッパと Slack 風チャットパネルのスタイル。

### `office.js`

canvas 描画ループ。部屋・デスク・アバター・吹き出し・サブエージェントの
ミニアバター・人事アバターのフレームごとの描画と、アバターの移動(デスク /
休憩室 / 出口への歩行)を担います。`window.OFFICE` として `setState`、
`faceDataUrl`、`hrSay` を公開します。純粋で DOM 非依存のロジックは `office/`
モジュールへ委譲しています。

### `office/specs.js`

ベンダー別アバターの外観(`CLI_SPECS`、`UNSET_SPEC`):body/accent/head/eye の色と
エンブレム。canvas とサイドバーの顔アイコンが共有する単一の真実の源です。
`UNSET_SPEC` は中立のフォールバックアバターで、人事(HR)と、LLM が未設定の席
(常駐チームの机)が共有します。

### `office/layout.js`

純粋なシーン幾何:`computeLayout(usedSeats)`、`deskPosition`、`breakSpot`、
`doorPosition`、`lowestFreeSeat`。フリーアドレスのデスクグリッドは 4 列 × 8 席
(`SEAT_COUNT`)を事前設置とし、空席には空机が描かれ、超過分は下の行へ
あふれます。1 行目の y は常駐チームの机の 1 行目と揃えています。左端の
常駐チームエリア(壁のない床パッチ `RESIDENT_ROOM`)とその空机 4 つ
(2 列 2 行の島)の座標 `residentDeskPosition` もここに定義します。canvas も DOM も触れないため単体テスト可能です。

### `office/small-talk.js`

休憩室の雑談ステートマシン。`createSmallTalk({ random })` は
`update(time, restingKeys)` と `bubbleFor(key)` を返します。random を注入できるため
テストで決定的に動作します。

### `office-client.js`

UI のトランスポート層。`connect({ onSnapshot, onStatus })` は SSE ストリーム
(自動再接続)をラップし、`runCleanup(text)` は人事 cleanup エンドポイントを
呼び出します。将来 SSE を Electron IPC に差し替える際は、このファイルだけを
変更すれば済みます。

### `app.js`

サイドバーの挙動:`#general` チャット(メンション・リアクション・タイムスタンプ)
の描画、社長(`@社長`)が新たにメンションされた際の WebAudio チャイム再生、
composer から人事 cleanup を起動する配線。クライアントストリームを
`window.OFFICE.setState` へ橋渡しします。

## デスクトップ(`electron/`)

### `main.js`

Electron メインプロセス。`startServer` により同一サーバをプロセス内に埋め込み、
`BrowserWindow` をそこへ向けます。これによりブラウザ経路とデスクトップ経路が
すべてのロジックを共有します。

### `preload.js`

将来の IPC ベースのトランスポート用プレースホルダ preload スクリプト。
`contextIsolation` 有効で動作します。必要になったら `contextBridge` で API を
公開します。

## テスト

`npm test` は外部フレームワークなしで `node --test` を実行します。決定性は、
本来なら非決定的になる要素を注入することで得ています:

- `createState` への **クロック** の注入(ステータス導出は経過時間に依存)。
- `createCleanup` への **OS 検査関数のスタブ** 注入。
- 各 watcher の `handleLine` への **`report` スタブ** 注入。
- `createSmallTalk` への **`random`** の注入。
