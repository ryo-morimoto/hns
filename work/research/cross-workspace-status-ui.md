# 他のワークスペースの状態を、切り替えずに見せる UI

2026-11-07 / 0102 のユーザーレビューから。調査ノート（実装前）。

## 問題文

- 誰の、どの場面か: 複数マシンで複数の仕事（プロジェクト）を並行させる 1 人の運用者。別の仕事が終わったか・止まっているかを確かめたい場面。
- 現在の行動: サイドバーでワークスペースを切り替え、その中の会話・タスク・実行を見る。切り替えるまで他ワークスペースの進捗が分からない。
- 何が改善すれば成功か: **切り替えずに**、各ワークスペースの「今この人が判断すべきこと（Needs you）」「進行中」「最近の完了」が分かる。状態から 1 操作でその仕事へ入れる。
- なぜ既存の方法では足りないか: ワークスペースが増えるほど、切り替えコストと「見落とし」が増える。通知はあるが、どの仕事の何が止まっているかは分からない。
- 制約: 自己ホスト・1 人利用・ローカル SQLite。ワークスペース数は数個〜十数個。常時 SSE は 0118。まずは集計 API（0115）が要る。

**何が分かれば判断が変わるか**: (1) 他製品が「件数」と「項目」のどちらを先に見せているか、(2) バッジの数と一覧の一致をどう保っているか、(3) 通知過多をどう抑えているか、(4) モバイルでクロームを増やさずに状態を見せる方法。

## 調査した Golden Examples

### 1. Slack — ワークスペース切替の番号バッジ

- 対象: 複数ワークスペースにサインインしたときのワークスペーススイッチャー（左上のワークスペースアイコン）。
- 観察（公式ヘルプ）:
  - 「A numbered badge will appear on the workspace icon with unread activity in the workspace switcher.」
  - デスクトップの Activity アイコンは番号バッジ、**モバイルの Activity は常にドット**で、番号はワークスペースアイコン側に出る。
  - バッジは「未読のメンション・招待・アプリ通知」。スレッド返信を番号から除外する設定がある。
  - ワークスペースは Ctrl+Tab / アイコンから切り替える。サイドバーのスイッチャー自体は非表示にできる。
- なぜ参考か: **切り替える前に、どのワークスペースに読むべきものがあるか**が分かる。数を出す場所（切替器）と、数を出さない場所（モバイルの Activity はドット）を分けている。
- 採るもの: ワークスペース行に未処理件数。モバイルは件数ではなくドットに落とす判断。数える対象をユーザーが絞れる（スレッド返信を除外）。
- 採らないもの: 「未読」中心の semantics。hns の中心は「判断待ち / 進行中 / 完了」で、既読管理ではない。
- 出典: [Slack — Triage notifications from the Activity tab](https://slack.com/help/articles/45573197224467-Triage-notifications-from-the-Activity-tab--legacy-) / [Switch between workspaces](https://slack.com/help/articles/1500002200741-Switch-between-workspaces)

### 2. Linear — Inbox / My Issues の横断優先リスト

- 対象: チームをまたぐ Inbox と My Issues。
- 観察（公式ドキュメント）:
  - Inbox は全通知が集まる。**priority inbox**、グループ化、**バッジ件数**を表示設定で変えられる。上限 2,000 件。スヌーズ・リマインダー・クイック検索（issue / team / project / priority で絞る）。
  - My Issues はチーム横断で、**urgent → SLA → blocker → cycle → active → triage → backlog → completed** の順にグループ化。セクションは該当するときだけ出る。開始済みが先。
  - 作成した issue、購読した issue、Activity（作成・更新・状態変更・コメント・PR）も同じ画面に集約。
- なぜ参考か: 「ワークスペース（チーム）をまたぐ」を、切替ではなく**優先順の 1 リスト**で解いている。件数だけでなく項目まで見せる。バッジ件数と一覧の実数を一致させる前提が読み取れる。
- 採るもの: Needs you → Running → 最近の完了 の優先順で横断表示。件数を出す場所と、グループ化・絞り込みの設定。開始済みを先に。
- 採らないもの: 高度なトリアージ設定・スヌーズ・2,000 件規模。hns は 1 人の小さなワークスペース群。
- 出典: [Linear — Inbox](https://linear.app/docs/inbox) / [Linear — My issues](https://linear.app/docs/my-issues)

### 3. Sentry — Projects 一覧の 24 時間スナップショット

- 対象: Projects ページ（所属チームの全プロジェクト）。
- 観察（公式ドキュメント）:
  - 所属チームのプロジェクトを**一覧**し、各プロジェクトに「直近 24 時間のエラーとトランザクションのスナップショット」「クラッシュフリーセッション率（release health 設定時）」「デプロイ（設定時）」を出す。アルファベット順。
  - Issues / Errors / Traces の上部フィルタは既定で「自分のプロジェクト」に絞られる。
- なぜ参考か: **ワークスペースを開かずに、全プロジェクトの状態を 1 画面で比較**できる。行の情報量が「状態 + 直近の量 + 鮮度」に絞られている。
- 採るもの: ワークスペース行に「進行中 / 判断待ち / 失敗 / 最終活動」のコンパクトな要約。全ワークスペースを常に一覧に置く。
- 採らないもの: 24 時間の時系列グラフ。hns は件数と鮮度で足りる。
- 出典: [Sentry — Projects](https://docs.sentry.io/product/projects/)

### 4. Cursor — Agents Window（マルチワークスペース）

- 対象: Cursor 3 の Agents Window / cursor.com/agents。
- 観察（公式ドキュメント）:
  - **Multi-workspace: work with agents across all your projects from one place.** 並列エージェント、cloud/local の引き継ぎ、worktree、diff / PR レビューを 1 画面で扱う。
  - 会話検索（⌘K）、サイドチャット、/goal など、エージェントの作業単位が一覧の主役。
- なぜ参考か: agentic system では「ワークスペース（リポジトリ）」よりも「走っている仕事（エージェント）」が一覧の主役になり得る。ワークスペースは**ラベル / フィルタ**であって、切り替えの単位ではない。
- 採るもの: 「実行」を横断リストとして持ち、各行にワークスペース名を添える。ローカル / クラウドの状態を同じ行で表す。
- 採らないもの: 多人数・多数並列・PR 管理までを 1 画面に詰めること。
- 出典: [Cursor — Agents Window](https://cursor.com/docs/agent/agents-window) / [Cursor — Agent overview](https://cursor.com/docs/agent/overview)

### 5. OpenAI Codex Cloud — タスクと環境

- 対象: Codex Cloud のタスク一覧 / CLI の recent cloud chats。
- 観察（公式ドキュメント）:
  - 環境（リポジトリ・セットアップ・ネットワーク）を再利用し、**タスクごとに独立した workspace** を持つ。
  - CLI から「list recent cloud chats and check their status」できる。タスクはリポジトリ / 環境の文脈を持つ。
- なぜ参考か: タスクの状態確認が「ワークスペースを開く」ではなく「タスクを一覧する」操作になっている。環境はタスクの属性。
- 採るもの: 実行 / 会話の一覧にワークスペース名を属性として出す。環境（project）を切り替えずに状態を見る。
- 出典: [OpenAI — Codex Cloud](https://developers.openai.com/codex/cloud/)

### 6. Vercel — 全プロジェクトのダッシュボード

- 対象: チームの Vercel dashboard。
- 観察（公式ドキュメント）:
  - 「You can view all projects in your team's Vercel dashboard. Selecting a project opens its project dashboard, where you can inspect deployments and configure its settings.」
  - プロジェクトはアバター・権限・ロールを持つ。デプロイの状態はプロジェクト dashboard で見る。
- なぜ参考か: 全プロジェクトを一覧する場所と、1 プロジェクトを深く見る場所を分けている。一覧は「選択のための面」。
- 採るもの: サイドバーは「全ワークスペースの要約 + 選択」、本文は「選択したワークスペースの詳細」という役割分担。
- 出典: [Vercel — Projects overview](https://vercel.com/docs/projects/overview)

### 7. ChatGPT モバイル（ユーザー提供スクリーンショット）

- 対象: モバイルのホームと会話画面（2026-11-07 にユーザーが提示）。
- 観察:
  - ホームは上バーがメニューと作成アイコンのみ。中央に挨拶、その下に「Recent artifacts」1 階層 + View all。下端は composer（+ / マイク / 音声 / モデル選択 / Project）。
  - 会話は上バーが戻る + タイトル + 共有のみ。本文は全幅。下端は composer。
- なぜ参考か: モバイルでは**階層と常設ナビを削り、本文と composer にスペースを渡す**。状態や最近のものは 1 階層のリストで見せる。
- 採るもの: 上バーは戻る/メニュー + 現在地 + 主要アクション 1 つ。ワークスペースの状態は drawer の行に畳む。下部バーは作らない。
- 出典: ユーザー提供スクリーンショット（2026-11-07）。関連する設計原则は interface.md 18。

### 8. バッジの作法 — Material 3 / Apple HIG

- 観察:
  - Material 3: small badge（ドット）は未読、large badge は件数。**アイコンの右上**に置き、**+ を含め 4 文字まで**。色の対応を変えない。
  - Apple HIG: タブバーのバッジは赤い楕円に白文字（数値か !）。**critical な情報だけ**に使い、意味を薄めない。
- なぜ参考か: 件数 / ドット / 色の使い分けと上限の慣習。hns の「needs you は数、running は静かなドット、done は消える」に直結する。
- 採るもの: 99+ の上限、色だけに頼らない、critical 以外はドット。
- 出典: [Material 3 — Badges](https://m3.material.io/components/badges/overview) / [Apple HIG — Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)

## 横断して見えたパターン

| # | パターン | 代表 | hns への含意 |
| --- | --- | --- | --- |
| P1 | 切替器に件数 / ドットを付ける | Slack | ワークスペース行とモバイルのメニューに「判断待ち」を出す。切替前に分かる |
| P2 | 横断の優先リスト | Linear | Needs you → Running → 最近の完了 を 1 リストに。ワークスペース名を行に添える |
| P3 | 全ワークスペースの要約一覧 | Sentry / Vercel | 各ワークスペース行に件数 + 鮮度。一覧は選択の面、本文は詳細 |
| P4 | 仕事（実行）中心の横断リスト | Cursor / Codex | 実行と会話を横断で並べ、ワークスペースは属性。切替を前提にしない |
| P5 | 沈黙の既定 | Linear / Apple | critical だけ数、通常はドット、done は件数を出さない。ノイズを増やさない |
| P6 | バッジの作法 | Material / Apple | 99+、右上、色だけに頼らない、ラベルで読み上げ |
| P7 | モバイルは低クローム | ChatGPT | 上バーは戻る/メニュー + 現在地 + 1 アクション。状態は drawer の行。composer が主役 |

## hns の提案（案 A: 要約 + 横断の優先リスト）

### デスクトップ

~~~text
┌ Workspace ────────────────────────────────┐
│ Needs you  3    hns 2 · scratch 1         │  ← 横断の件数。行を開くと横断リスト
│ Running    2    hns 1 · scratch 1         │
│ Done today 4    hns 3 · scratch 1         │  ← 折りたたみ。件数は小さく
├ Workspaces ────────────────────────────────┤
│ ● hns        2 running · 1 needs you · 12m │  ← 状態 + 鮮度。選択中は展開
│   ├ 会話  Web の土台                        │
│   ├ 会話  デザインシステムのレビュー         │
│   └ タスク doing · 実行 3                   │
│ ○ scratch    all clear · 2h                │
└────────────────────────────────────────────┘
~~~

- **Needs you / Running / Done today** は全ワークスペースの集計。各件数の横に内訳（どのワークスペースか）を出し、クリックで横断リストを開く。
- **Workspaces** の各行は、切替前でも「件数 + 最終活動」が見える。選択中の行だけ会話 / タスク / 実行を展開する。
- 並びは **Needs you が多い順 → Running → 最終活動が新しい順**。選択中のワークスペースは先頭に固定。イベントのたびに行が飛ばないよう、並び替えは閾値付き / 手動更新。
- 件数は一覧の実数と一致させる。0 は数字を出さず「all clear」。99 超は 99+。
- 色は critical（needs you / failed）だけ。running は accent のドット + 件数。done はドット（未見）か「12m ago」で、件数を常時出さない。

### モバイル

~~~text
┌ ☰  hns                         ● 2 ┐  ← メニューに件数ドット（needs you）
│ Workspace                           │
│   Needs you 3                       │
│   Running   2                       │
│                                     │
│   hns      2 running · 1 needs you  │  ← drawer の行に同じ要約
│   scratch  all clear                │
└─────────────────────────────────────┘
~~~

- 上バーは従来どおり低クローム。メニューアイコンに **needs you のドット / 件数**だけを付ける。
- drawer のワークスペース行に件数と鮮度。行をタップで切替 + drawer を閉じる。
- composer は 0105。状態表示のために下部バーは作らない。

### インタラクション / アクセシビリティ

- 件数は aria-label で「hns: 実行中 2、判断待ち 1」のように読む。数字だけにしない。
- ライブ更新は aria-live=polite の要約 1 行（「hns に判断待ちが 1 件増えました」）。行ごとに annouce しない。focus は動かさない。
- キーボード: J/K で横断リスト、Enter で項目へ。数字キーでワークスペース切替は 0103 のコマンドと重複するので保留。
- 更新のたびに並びが変わらないよう、ソートは「needs you の有無が変わったとき」「手動更新」だけ。reduced motion でドットの点滅を止める。
- 空: 「all clear」を 1 行。ゼロ件のワークスペースも一覧から消さない（存在を忘れない）。

## データ契約（0115 への要求）

現状の API では、ワークスペースごとの状態を 1 回で取れない（/api/projects は名前だけ、/api/state は全体のライブ task で project を持たない）。**0115（Workspace overview）で集計 DTO を返す**必要がある。

~~~ts
// 名前は案。core の公開 DTO として 0115 で決める
interface WorkspaceOverview {
  projectId: ProjectId;
  name: string;
  needsYou: number;
  running: number;
  failed: number;
  doneToday: number;
  lastActivityAt: string | null;
  // 横断リストを出す段階で、上位項目か件数だけかを決める
  items?: WorkItemSummary[];
}
~~~

- 横断の Needs you / Running リストを出すなら、項目レベルの DTO（0116 WorkItem + 0117 ack）が要る。最初のスライスは「件数 + ワークスペース行」に留め、項目リストは 0116/0117 の後でよい。
- SSE（0118）で件数を更新する。まずは画面表示時の取得 + 手動更新でも成立する。
- 件数はサーバで数える（N+1 を避ける）。一覧の実数と一致させる。

## 実装の段階

1. **0115**: ワークスペース overview の DTO / ルート / fixture。件数の定義（needs you = 承認待ち + blocked + waiting など）を決める。
2. **0102 / 0104**: サイドバーに全ワークスペースの要約行と、横断の Needs you / Running 件数。まずは件数のみ。fixture で確認。
3. **0116 / 0117**: 項目レベルの横断リストと ack。件数から項目へ。
4. **0118**: SSE で件数とリストを更新。aria-live と並びの安定。
5. **0113**: 390 / 320 / 1280 / 1440 と長文ワークスペース名、キーボード、コントラストを確認。

## 採らない案

- ワークスペースごとのタブを増やす: 切替が減らない。階層が増える。
- 切替後にだけ状態を出す: 元の問題のまま。
- すべての件数を常時表示: ノイズ。done はドット / 鮮度で足りる。
- 赤を running に使う: critical の意味が薄れる。
- 通知センターを別に作る: サイドバーで足りる。まず 1 画面。

## 未確定

- U-01: 「Needs you」の定義（blocked / waiting / 承認待ち / ack 未了のどれか）。0115 / 0116 で決める。
- U-02: 横断リストを最初から出すか、件数だけか。→ 件数だけを先に。項目は 0116/0117。
- U-03: done の窓（今日 / 24h / 直近 N 件）。→ 今日 + 鮮度。
- U-04: ライブ更新の頻度と並びの安定。SSE 0118 で決める。
- U-05: ワークスペース数が増えたときの折りたたみ（10 以上）。0113 で確認。

## 参考リンク

- Slack: [Activity badges](https://slack.com/help/articles/45573197224467-Triage-notifications-from-the-Activity-tab--legacy-) / [Switch between workspaces](https://slack.com/help/articles/1500002200741-Switch-between-workspaces)
- Linear: [Inbox](https://linear.app/docs/inbox) / [My issues](https://linear.app/docs/my-issues)
- Sentry: [Projects](https://docs.sentry.io/product/projects/)
- Cursor: [Agents Window](https://cursor.com/docs/agent/agents-window) / [Agent overview](https://cursor.com/docs/agent/overview)
- OpenAI: [Codex Cloud](https://developers.openai.com/codex/cloud/)
- Vercel: [Projects overview](https://vercel.com/docs/projects/overview)
- Material 3: [Badges](https://m3.material.io/components/badges/overview)
- Apple HIG: [Tab bars](https://developer.apple.com/design/human-interface-guidelines/tab-bars)
- ChatGPT mobile: ユーザー提供スクリーンショット（2026-11-07）
