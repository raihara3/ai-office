# アーキテクチャとファイル構成

本ドキュメントはコードベースの詳細な地図です。各ソースファイルとその役割を
記載します。アプリの概要や起動方法については [README](../README.md) を参照して
ください。

## 設計原則

アプリケーションの **core**(state + watchers + cleanup)は、いかなるトランスポートからも分離されています。
そのため同じロジックを、HTTP/SSEアダプタから駆動したり、Electron に組み込んだり、テストから直接動かしたりできます。
依存は内向き(inward)に向きます:

```
index.js → core.js → state.js / watchers/* / cleanup.js / residents/*
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
常駐チーム(`residents/`)はこのパイプラインの*上流*に位置します: スケジュールに従って
CLI をヘッドレス起動すると、CLI が通常のトランスクリプトを書き出すため、既存の
tail → watcher → state の流れがそのまま実行を可視化します。

## ファイルツリー

```
server/                バックエンド(npm 依存なし。永続化は node:sqlite)
  index.js             エントリポイント + startServer()(Electron 埋め込み契約も兼ねる)
  core.js              state + watchers + cleanup を合成; ライフサイクル(start/stop)
  http.js              HTTP 静的配信 + SSE + /api/* を core に橋渡しするアダプタ
  state.js             createState() ストア, deriveStatus()(純粋), #general ログ
  state.test.js        ストア + ステータス導出のテスト
  tail.js              汎用 JSONL 追従(fs.watch + 定期再スキャンのフォールバック)
  cleanup.js           createCleanup(): 終了済みセッション検出(ps + lsof)
  cleanup.test.js      人事(HR)退勤ヒューリスティックのテスト
  residents/           常駐チーム(スケジュール実行される常駐エージェント)
    residents.js       オーケストレータ: tick ループ + precheck + 報告生成
    resident-store.js  residents / teams テーブルの読み書きと検証
    resident-store.test.js 検証・保存・席重複・アーカイブのテスト
    resident-import.js 旧 resident ファイル群からの一回限りのインポート
    resident-import.test.js インポート・ghost 生成・クリーンアップのテスト
    scheduler.js       トリガー判定(schedule / interval)の純粋関数
    scheduler.test.js  トリガー判定のテスト
    registry.js        セッションレジストリ(session_bindings テーブル)
    registry.test.js   フラグメント照合・上限・アーカイブ済み解決のテスト
    runner.js          ヘッドレス CLI 実行(コマンド構築 + タイムアウト)
    runner.test.js     コマンド構築・出力パースのテスト
    database.js        office.db のオープンとスキーマ移行(node:sqlite / WAL)
    database.test.js   スキーマ移行・再オープン・新版 DB 拒否のテスト
    whiteboard.js      ホワイトボード(reports テーブルの報告 + 既読・ピン管理)
    whiteboard.test.js 報告の掲示・既読・アーカイブ・ピンのテスト
    board.js           カンバンボード(cards テーブルのカードストア + 並び順)
    board.test.js      カードの起票・並び替え・アーカイブ・追記のテスト
    legacy-import.js   旧 Markdown ストアからの一回限りのインポート
    legacy-import.test.js インポートとクリーンアップのテスト
  watchers/
    claude.js          Claude Code トランスクリプト解析(handleLine + startWatcher)
    codex.js           Codex CLI rollout ログ解析
    gemini.js          Gemini CLI チャットログ解析
    watchers.test.js   3 つの watcher の行パーステスト
public/                フロントエンド(静的 ES モジュールとして配信)
  index.html           マークアップ: アプリバー + カンバンストリップ + canvas / ボードビュー + インボックス + ドロワー
  style.css            ライト SaaS テーマの UI スタイル一式
  office.js            canvas 描画ループ(部屋・デスク・アバター・吹き出し)
  office/
    specs.js           ベンダー別アバターの色 + エンブレム
    layout.js          純粋なシーン幾何(デスク・休憩スポット・座席)
    layout.test.js     幾何のテスト
    small-talk.js      休憩室の雑談ステートマシン(random 注入可能)
    small-talk.test.js 雑談のテスト
    pathfinding.js     デスクを避けるグリッド経路探索(空きスペースのみを歩く)
    pathfinding.test.js 経路探索のテスト
  office-client.js     トランスポートクライアント(SSE + cleanup API), IPC へ差し替え可能
  app.js               DOM 側 UI(ストリップ・ボード・インボックス・ドロワー)の描画と配線
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

state ストア・人事 cleanup・3 つの CLI watcher・常駐チームを、トランスポート
非依存の 1 つのハンドル(`start`/`stop`、`subscribe`、`getSnapshot`、
`postMessage`、`previewCleanup`、`runCleanup`、常駐員 CRUD / 実行、
ホワイトボード読み出し / アーカイブ、カンバンボード操作)に合成します。スナップショットには常駐チームの
オーバーレイを施します: 各従業員に所属常駐員をタグ付けし(フロントエンドは
その席を常駐チームの島に配置)、常駐員名簿とホワイトボードの未読数と
カンバンボードのカード数を添付
します。リフレッシュタイマーを保持し、経過時間のみで起きる
`working → break` の遷移もクライアントへ届くようにします。

### `http.js`

HTTP/SSE トランスポートアダプタ。静的 UI を配信し、状態スナップショットを
Server-Sent Events(`/events`)でストリームし、人事 cleanup のエンドポイント
(`GET /api/cleanup/preview`、`POST /api/cleanup`)、常駐チーム管理
(`GET /api/residents`、`PUT`/`DELETE /api/residents/:name`、
`POST /api/residents/:name/run`)、ホワイトボード(`GET /api/whiteboard`、
`POST /api/whiteboard/read`、`POST /api/whiteboard/archive`)、カンバンボード
(`GET /api/board`、`POST /api/board/create`/`move`/`archive`/`note`)を公開します。状態を変更するリクエストには
Origin ベースの CSRF ガードを掛けます。ドメインロジックは
すべて core にあり、本ファイルは配管(plumbing)に徹します。

### `state.js`

セッション状態ストア。`createState()` はクロックを注入可能な独立インスタンスを
返します。watcher は observation を `reportEvent` に流し込み、これは小さな純粋
ヘルパー群の上に構築された読みやすいパイプラインです:

- `createSession` — 新規セッションの雛形。
- `applyTiming` / `applyFields` / `applyActivityLog` / `applyTurnState` /
  `applySubagents` / `applyMcpCall` — observation の 1 側面を変異(mutation)で
  適用。クロックや I/O を持たないため、ストアは決定的に保たれます。
  `applyActivityLog` は 1 ターン分の活動を配列に蓄積し(新しい指示でリセット)、
  作業状況ビューが最新の 1 件ではなく作業の流れを表示できるようにします。
- `isDismissed` — 人事 cleanup が残す tombstone(墓標)を尊重します。tombstone は
  `<dataDirectory>/dismissed-sessions.json` に永続化され、起動時に読み込むため
  退勤状態はサーバー再起動をまたいで保持されます(セッション寿命
  `SESSION_EXPIRE_MS` を超えた古い墓標は読み込み時に破棄)。
- `updateGeneralChannel` — 状態遷移に応じて `#general` メッセージ(依頼、🫡 の
  受領リアクション、完了 / 確認依頼の返信)を投稿します。注入された
  `isResidentFile` が真のセッション(常駐チームの実行)ではこのやり取りを
  抑止します(報告通知は residents モジュールが自前で投稿するため)。

`deriveStatus(session, now)` は独立した純粋関数として export され、セッションと
現在時刻を `working` / `break` / `blocked` / `waiting` にマップします。

### `tail.js`

ディレクトリツリーに対する汎用 JSONL 追従。パターンに一致する最近更新された
ファイルを発見し、追記行をコールバックへストリームします。即応性のための
`fs.watch` に加え、定期再スキャンをフォールバックとして併用します(`fs.watch` は
macOS でイベントを取りこぼすことがあるため)。3 つの watcher が共有します。

### `cleanup.js`

人事 cleanup。`createCleanup()` は state インスタンスに加え、OS 検査関数
(プロセス一覧・オープンファイル・ファイル存在)を注入として受け取る
ため、退勤ヒューリスティックを実プロセスに触れずに単体テストできます。実行中の
プロセスは (CLI, 作業ディレクトリ) ごとに 1 つの「席」を付与し、直近に活動した
セッションのみが席を保持、残りは退勤対象となります。`working` 表示中の
セッションは決して退勤させず、曖昧なケースは「生存」側に倒します。注入された
`isProtected` が真のセッション(常駐チームの実行)は常勤スタッフとして
退勤対象から除外します。退勤時はログファイル(jsonl)を削除せずに残し、退勤
状態は state の tombstone(退勤時点の最終イベント時刻)で管理します。以降、
その時刻以前のログ行の再生は無視されるため再スキャンで復活せず、より新しい
活動があった場合のみセッションが復帰します。tombstone はディスクに永続化される
ため、退勤状態はサーバー再起動をまたいで維持されます。

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
  (`~/.gemini/tmp/<project>/chats/session-*.jsonl`、サブエージェントは 1 階層
  深い `chats/<id>/<uuid>.jsonl`): メタデータと `$set` 状態パッチ、CLI 0.54
  以降はメッセージ直接追記(ツール呼び出しは `content` ではなくメッセージ
  直下の `toolCalls` 配列)。メッセージ形状はバージョン間で変わるため、JSON
  を汎用的に走査するベストエフォート実装です。

### `residents/`

常駐チーム: 左上のデスク島に常駐する最大 6 人のエージェント(1 人 = 1 役割)。
設定(プロフィール・役割プロンプト・実行簿記)・チーム・セッション紐付け・
報告・カンバンカードはすべて
`~/Library/Application Support/ai-office/office.db`(SQLite)に永続化され、
編集はアプリ内パネル(ドロワー)で行います。各常駐は 1 つのチームに所属し
(1:N、既定は 'default' チーム)、カード・報告は常駐 id への外部キーで
リレーションされます(スキーマは [database.md](database.md))。

- **`residents.js`** — オーケストレータ。30 秒ごとの tick で常駐行を
  再読込し、期日が来たトリガーを発火します。トリガー起点の実行は「実際に
  作業があるとき」だけ開始します。すなわち、その常駐員にカンバンのカードが
  割り当てられており、かつ `precheck` シェルコマンドが設定されている場合は
  その標準出力が空でないこと、の両方を満たす必要があります(いずれかが
  空なら実行スキップ)。割り当てカードがなければ実行せず、無意味な報告を
  毎回上げないようにします。実行完了時にはホワイトボード報告と `#general`
  への報告通知を生成します。
  トリガーが期日でないアイドルな常駐員は、自分のカンバン列の一番上の
  カードをタスクとして実行します(precheck はスキップし、カードの本文を
  プロンプトの「今回のタスク」節に含める)。カード実行が info で完了すると
  カードを自動アーカイブ、review-needed または失敗ならユーザー列へ移動し、
  トリガー起点の実行が review-needed で終わった場合はユーザー列にカードを
  自動起票します。報告の `task` 列には カード id を刻印してカードと
  紐付けます。実行中カードの移動・アーカイブはここで拒否します。
- **`resident-store.js`** — residents / teams テーブルの読み書きと設定の
  検証。公開 API は名前ベース(save は席の重複を拒否、remove は
  `archived_at` の刻印でアーカイブ済みの名前は再利用可)。キャッシュせず
  毎回 DB へ読みに行きます。
- **`resident-import.js`** — 旧ファイル群(`residents/<name>/` と
  `session-registry.json`)から office.db への一回限りのインポート。
  取り込んだ常駐は旧スラッグ名を id として保持し、カード・報告だけが参照
  する行方不明の名前にはアーカイブ済みの ghost 行を作って外部キーを成立
  させます。コミット後にのみ元ファイルを削除します。
- **`scheduler.js`** — トリガー判定の純粋関数群。
  `{type: "schedule", days, times}`(曜日 + 時刻)と
  `{type: "interval", minutes, activeDays?, activeHours?}` をサポートし、
  schedule の発火は 1 時間まで遅延を許容(それより古い回はスキップ)します。
  現在時刻は常に引数で受け取ります。
- **`registry.js`** — セッションレジストリ(`session_bindings` テーブル)。
  実行が生むセッションログを常駐員に紐付けて永続化し、その席をフリー
  アドレスのグリッドではなく常駐チームの島に固定します。行単位の INSERT
  なので複数プロセスでも紐付けが失われません(照合は JS 側: パスは完全
  一致・セッション uuid は部分一致、新しい順)。
- **`runner.js`** — ヘッドレス CLI 実行(`claude -p --session-id <uuid>`、
  `codex exec --sandbox …`、`gemini --skip-trust -p`)。read-only / edit のモードを各 CLI の
  権限フラグにマップし、30 分のタイムアウトと常駐員ごとの同時 1 実行を
  強制します。コマンド構築と出力パースは純粋関数として export されます。
- **`database.js`** — `<dataDirectory>/office.db` を `node:sqlite` の
  `DatabaseSync` で同期的に開き、WAL と `PRAGMA user_version` ベースの
  スキーマ移行を適用します。アプリより新しいバージョンの DB は推測せず
  起動を拒否します。スキーマの全体像(ER 図)は
  [database.md](database.md) を参照してください。
- **`whiteboard.js`** — 常駐員から人間への報告。`reports` テーブルの行で、
  既読・お気に入り(ピン)はカラム、ボードから外す操作は `archived_at` の
  刻印です(行は削除しません)。ピン中の報告はアーカイブを拒否します。
- **`board.js`** — カンバンボードのカードストア。カード = `cards` テーブル
  の行、列 = 担当者(`user` または常駐名)。列内の並び順は `position`
  カラムで、ドラッグのたびに対象列を密に振り直します。ボードから外した
  カードは `archived_at` を刻印します(行は削除しません)。ユーザーの
  追記はカード本文への「## 追記」節として蓄積されます。
- **`legacy-import.js`** — SQLite 移行前の Markdown ストア
  (`outbox/*.md`・`board/*.md` とサイドカー JSON)を初回オープン時に一度
  だけ `office.db` へ取り込みます。取り込みは単一トランザクションで、
  コミット後にのみ元ファイルを削除し、完了マーカーを `meta` テーブルに
  残して再実行を防ぎます。

## フロントエンド(`public/`)

ES モジュールとしてドキュメント順に読み込まれます:`office.js`(`window.OFFICE` を
設定)、`office-client.js`(`window.OFFICE_CLIENT` を設定)、`app.js`(両者を利用)。

### `index.html`

マークアップ:アプリバー(`#appbar`。AI OFFICE ブランド、ビュータブ
「オフィス / ボード」、接続ステータスピル、テーマ切替ボタン(🌙/☀️)、
アバター退勤ボタン、＋ タスク ボタン)、担当者別のカンバンストリップ
(`#kanban-strip`)、`<canvas>` とタブで切り替わるインプレースのフルボード
(`#board-view`)、インボックスサイドバー(トレイアイコンと未読・要確認
カウント付きヘッダと報告一覧)、および右スライドインドロワー(`#drawer`。
カード詳細・タスク起票フォーム・常駐員の作業状況・割り当てフォームを
1 セクションずつ表示)。`<head>` のインラインスクリプトが初回描画前に
`localStorage`(キー `ai-office-theme`、未設定なら OS の
`prefers-color-scheme`)からテーマを読んで `data-theme` を設定するため、
保存済みのダークテーマがライトで一瞬光ることはありません。

### `style.css`

SaaS テーマ(ライト / ダーク。ダーク用トークンは
`:root[data-theme="dark"]` で同じトークン一式を上書き)。アプリバー、
カンバンストリップ、オフィス canvas
ラッパとフルボードビュー、インボックスサイドバー、右ドロワーのスタイル。

### `office.js`

canvas 描画ループ。部屋・デスク・アバター・吹き出し・サブエージェントの
ミニアバター・人事アバターのフレームごとの描画と、アバターの移動(デスク /
休憩室 / 出口への歩行)を担います。常駐チームの席は 3 状態で描き分けます:
未割り当て(こちらを向くグレーのアバター)、割り当て済みアイドル(ベンダー
カラーでこちらを向き、画面は消灯。稼働オフなら ⏸)、実行中(モニターに
向かい、画面点灯 + ステータス吹き出し)。常駐員は休憩室にも出口にも
行きません。ホワイトボード(未読報告数 + ユーザー列カード枚数の合計バッジ
付き。ユーザー列にカードがあれば赤)も描画し、ホワイトボード /
常駐デスクのクリックは CustomEvent として `app.js` へ通知します
(`office:whiteboard-open`。常駐デスクは上下 2 領域に分かれ、モニタ側は
作業状況ビューを開く `office:resident-activity-open`、アバター側は設定
ドロワーを開く `office:resident-seat-open`)。
`window.OFFICE` として `setState`、`faceDataUrl`、`hrSay` を公開します。
純粋で DOM 非依存のロジックは `office/` モジュールへ委譲しています。

### `office/specs.js`

ベンダー別アバターの外観(`CLI_SPECS`、`UNSET_SPEC`):body/accent/head/eye の色と
エンブレム。canvas のアバター描画の単一の真実の源です。
`UNSET_SPEC` は中立のフォールバックアバターで、人事(HR)と、LLM が未設定の席
(常駐チームの机)が共有します。

### `office/layout.js`

純粋なシーン幾何:`computeLayout(usedSeats)`、`deskPosition`、`breakSpot`、
`doorPosition`、`lowestFreeSeat`。フリーアドレスのデスクグリッドは 3 列 × 6 席
(`SEAT_COUNT`)を事前設置とし、空席には空机が描かれ、超過分は下の行へ
あふれます。各行の y は常駐チームの机の行と揃えています。左端の
常駐チームエリア(壁のない床パッチ `RESIDENT_ROOM`)とその空机 6 つ
(3 列 2 行の島)の座標 `residentDeskPosition`、常駐デスクのクリック領域
`residentDeskHitRect`(とその上帯だけを切り出すモニタ領域
`residentMonitorHitRect`)、上壁のホワイトボードのクリック領域 `WHITEBOARD`
もここに定義します。canvas も DOM も触れないため単体テスト可能です。

### `office/pathfinding.js`

デスクを避けるグリッド経路探索。`deskFootprint(anchor)` が
`drawDeskFurniture` に対応するデスクの障害物矩形(モニタ上端から脚まで。
椅子はその下端の外側)を返し、`findPath(start, goal, obstacles, bounds)` が
16px グリッド上の A*(斜め移動はコーナー抜けを禁止)で経路を求め、
可視線で直線化した経由点(始点を除き終点を含む)を返します。到達不能なら
`[goal]` に退避するため、描画側は従来どおり直進にフォールバックします。
`office.js` はこれを使い、アバターがデスクやモニタの上を横切らず空きスペース
だけを歩くようにします。canvas も DOM も触れないため単体テスト可能です。

### `office/small-talk.js`

休憩室の雑談ステートマシン。`createSmallTalk({ random })` は
`update(time, restingKeys)` と `bubbleFor(key)` を返します。random を注入できるため
テストで決定的に動作します。

### `office-client.js`

UI のトランスポート層。`connect({ onSnapshot, onStatus })` は SSE ストリーム
(自動再接続)をラップし、`runCleanup(text)` は人事 cleanup エンドポイントを
呼び出します。常駐チーム管理(`listResidents` / `saveResident` /
`deleteResident` / `runResident`)、ホワイトボード(`listReports` /
`markReportRead` / `archiveReport`)、カンバンボード(`listBoard` /
`createCard` / `moveCard` / `archiveCard` / `appendCardNote`)の API 呼び出しもここに集約します。将来 SSE を Electron
IPC に差し替える際は、このファイルだけを変更すれば済みます。

### `app.js`

DOM 側 UI の挙動:カンバンストリップ(担当者別の列。ベンダーカラーの
担当チップ・件数・実行中の 作業中 バッジ・先頭 3 枚のカードプレビューと
`ほか N 件`、列ごとの ＋ クイック起票)の描画、ビュータブによる canvas と
インプレースのフルボード(`#board-view`。列 = ユーザー + 常駐員(席順)、
HTML5 drag & drop での並び替え・再アサイン。担当常駐が削除されたカードは
ユーザー列に「担当不在」バッジ付きで表示)の切り替え、インボックス
サイドバー(`snapshot.whiteboard` の報告一覧。ヘッダに未読・要確認
カウント、展開でインライン表示 + 既読化、✕ でボードから外す)の描画、
アバター退勤ボタンから人事 cleanup を起動する配線、社長(`@社長`)が
新たにメンションされた際の WebAudio チャイム再生(`snapshot.messages` を
参照。チャット自体の描画はしません)。クライアントストリームを
`window.OFFICE.setState` へ橋渡しします。canvas の CustomEvent
(ホワイトボードクリックはボードビューへの切り替え)と各ボタンを受けて、
右スライドインドロワー(`#drawer`)に 1 セクションずつ表示します:
カード詳細(本文・紐付く報告・追記フォーム・完了ボタン)、カード起票
フォーム(＋ タスク ボタン / 列の ＋ で開き、後者は担当を事前選択)、
常駐員の作業状況ビュー、常駐員の割り当てフォーム(作成 / 編集 /
割り当て解除 / 今すぐ実行)。

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
- `createResidentStore` / `createSessionRegistry` / `createWhiteboard` /
  `createBoard` へは `openDatabase({ location: ':memory:' })` の
  **インメモリ SQLite** を注入。インポータのテストは加えて
  **ファイルシステムのスタブ** を注入します。
  scheduler と runner のコマンド構築は
  現在時刻や設定を引数に取る純粋関数です。
