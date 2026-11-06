# 分散型 AI Agent Platform — 要件・基本設計・判断状態 v0.3

- 更新日: 2026-11-06
- 文書種別: 継続開発用の統合設計記録（Requirements / Architecture / ADR / Decision Log / Open Issues / Next Steps）
- 状態: **要件の方向性を記録済み／責務境界は設計ベースラインとして採用／実装適合性は未検証**
- 工程ゲート（提案）: **Go with Conditions**（責務境界を前提に詳細検討・限定PoCへ進行）。本番実装・運用のGoではない。
- 意思決定者: ユーザー。以下の「採用」は会話で合意された方針または提案済みの設計ベースラインを示し、技術PoCによる実証を意味しない。
- 前版: `requirements-design-v0.2.md`。本書は後続会話での**Conversation / Progress First**および**ZedのProgramming Interface参照**への方針変更を優先して反映する。

## 0. 目的・プロダクト像

**セルフホスト可能な単一UIから、複数マシン上のAI Agentをチャット・進捗観測・プロジェクト・タスク・ワークフローで統合操作でき、必要に応じて同じWorkspaceのファイルを編集・差分確認できるプラットフォーム。**

- **Primary UX: Conversation / Progress First**。Editor Firstにはしない。Editorは主要機能ではあるが、デフォルト画面や中心となるドメインではない。
- **Zedの参照対象: 見た目ではなく、Project / Worktree / Buffer / File I/O / Git / Remote Developmentの概念分離とプログラミングインターフェース。** ZedのUI外観・GPUIのWeb移植は目標外。
- **Agent Runtime: Pi Durableを第一候補**とする。Agent LoopやConversationの永続処理を重複実装せず、境界越しに使う。
- **Build vs Buy**: 既存技術を優先利用し、自作はControl Plane、Workspace統合、Remote Worker Protocol、Project/Task/Workflow、Web UXなどプロダクト固有の差分に集中。
- 最初の利用者は「複数開発マシンを持つ個人開発者」という**仮説**。チーム向け機能や規模要件は未確定。

## 1. ユーザー指定の最終11要件（原番号を維持）

| # | 要件 | 最終優先度 | 設計上の解釈・受入の方向 |
|---|---|---|---|
| 1 | インターフェースをセルフホストできる | Must | 自分でWeb UIと管理APIを運用できる |
| 2 | 複数マシンでCore Agentを動かせる | Must | 複数マシンのAgent実行をサポート。**中央Harness＋遠隔Toolだけでは文言通りの要件を満たすか未確定** |
| 3 | 一箇所のインターフェースから全マシンのAgentを操作 | Must | Machine/Agent選択、Run起動・停止・状態観測 |
| 4 | 普通のチャットとして使える | Must | 会話履歴、Streaming、モデル選択、返信・中断 |
| 5 | プロジェクト管理 | Must | ProjectにWorkspace・会話・タスクを紐付け |
| 6 | ワークフローグラフ設定 | Must | Versioned workflowの編集・検証・実行・観測 |
| 7 | タスク管理 | Must | User-facing Taskの作成、割当、状態、履歴 |
| 8 | 複数Model Provider | Must | ChatGPT OAuth、OpenCode Go、`commandgode`（名称未確認）、Grok、Claudeを希望。**各接続・認証の利用可能性は個別検証** |
| 9 | Editor（Zedのようなもの） | **Must** | Web Editorを提供。ただしZedの外観コピーではなくWorkspace操作モデルを参考にする |
| 10 | Git Diff Viewer | Want | リポジトリの差分を参照・比較 |
| 11 | Web UI Grabber Extension | Want | ブラウザ側の要素/ページをユーザー操作で取得してAgentへ渡す（詳細は未確定） |

> 内部のFR-IDは前版で追加した信頼性・権限などと番号が重複するため、本書では**上記ユーザー番号を正本**とし、システム横断要件は`NFR-*`、設計判断は`ADR-*`、未決事項は`U-*`を使用する。

### MVP候補（最終Mustとは区別）

セルフホスト起動、2マシン接続、Conversation/Progress、基本的なモデル切替、権限つきWorkspaceアクセス、遠隔ツール実行、最小のファイル編集（開く・編集・条件付き保存・外部変更検知）、状態再開の検証。Project/Task/Workflowの完成版、全OAuth方式、Git Diff Viewer、Grabberは段階導入。**MVPの厳密な範囲は未承認**。

## 2. 基本概念と用語

| 概念 | 意味・所有領域 |
|---|---|
| Project | ユーザーの作業・管理単位。複数Workspace、Tasks、Conversations、Workflowsを持てる。Applicationが所有 |
| Workspace | 作業可能なファイルRoot、実行先、操作ポリシーを束ねる論理的なアクセス境界。**ZedのWorkspace（ウィンドウのルート）と同義ではない** |
| Workspace Root | Machine上の許可済みDirectory/Worktreeを指す。Workspaceは複数Rootを持ちうる |
| Machine / Worker | ホストと接続主体。Worker認証・実行・イベント配信はControl Plane/Workerで分担 |
| Execution Target | Toolが実際に動く対象。Machineと単純な一対一に固定しない |
| Conversation | Pi Durable側のAgent対話・内部実行履歴の境界 |
| Agent Run | Applicationが識別する実行単位。Pi DurableのSubmission/Tasksとの対応関係はアダプターで管理 |
| User Task | プロジェクト側の仕事。Pi Durable内部のDurable Taskとは別概念 |
| Workflow Definition / Run | ユーザーが定義するグラフと、その特定版の実行。Applicationが所有 |
| File Snapshot / Version | 対象ファイルの読み取り結果とその改訂識別子。Workspaceが整合性契約を担う |
| Editor Buffer | 未保存の編集内容を保持する独立したクライアント状態。実ファイルと同じ正本ではない |
| Git Repository / Index / HEAD | Gitが所有する状態。Workspace Git Adapterは参照・操作インターフェースを提供 |
| Progress Projection | Pi DurableイベントやWorkspaceイベントから作るUI用の投影。実行の正本にはしない |

## 3. ADR-001 — WorkspaceとPi Durableの責務を分離する

**状態：採用（アーキテクチャ原則）。** 実装適合・性能・障害保証を検証したという意味ではない。

### 3.1 決定

1. **Pi Durable**がConversation、モデル生成、Agent内部Task、Tool Invocation、Agent側Checkpoint/Resumeなどの**Agent Execution State**を所有する。
2. **Workspace Boundary**がWorkspace/Root識別、ファイルアクセス、認可されたPath解決、Version、競合検出、Mutation照合、File Eventsなどの**Workspace Access & Consistency**を担う。ファイル内容の最終的な正本は対象Machine上のFile Systemにある。
3. **Control Plane/Application**がProject、User Task、Workflow、Machine/Worker Registry、RunとWorkspace/Execution Targetの関連、利用者認可、Progress Projectionを所有する。
4. **Editor Buffer**は実ファイルの保存前状態を独立して保持する。保存はWorkspaceのMutation Contractを経由する。
5. **Git**は独立したRepository状態を正本とし、Workspace Git Adapterが`status`/`diff`等を公開する。Git ChangesはEditor Bufferの直列の後段ではない。
6. Pi DurableとWorkspaceの接続候補にはPi Durableの**Execution Environment / `ExecutionEnv`**を使い、内部Storageや実装クラスを直接結合しない。
7. Pi DurableのCheckpointと遠隔File Mutationは**同一トランザクションではない**。外部副作用の結果不明・重複・競合を別途扱う。

### 3.2 採用の根拠（区分つき）

| 根拠 | 種別 | 説明・限界 |
|---|---|---|
| Pi DurableにConversation、Tasks、Execution Environment等の仕組みがある | 公開資料に基づく情報 | Agent Runtimeを再実装せずに済む可能性。実バージョンのAPI確認が別途必要 |
| ZedがProject/Worktree/BufferやRemote Developmentを区別している | 公開資料に基づく情報 | ファイルの実体とEditorの未保存状態を分ける参考事例。Zedの概念をそのまま移植するわけではない |
| Agent状態とWorkspace状態では正本・ライフサイクル・再試行要件が異なる | アーキテクチャ上の推論 | 同じStore/Transactionに混ぜず所有権を分ける根拠 |
| ExecutionEnvが外部実行環境を差し替える拡張点になる | 公開資料に基づく設計仮説 | 書き込み条件、認可、イベント、遠隔障害まで適合するかはPoC対象 |
| 外部File I/OとAgentのCommitは原子的ではない | 分散境界の技術的制約 | 冪等化・照合・結果不明の扱いが必要。Exactly-onceは未保証 |
| 影響の大きな境界を決め、内部実装の詳細はPoCで決める | ユーザー提供の開発プロセスに沿う判断 | 全詳細の確定は不要。リスクが高い依存実装は条件付き |

### 3.3 明確な非決定事項

- **中央Pi Durableか、各マシンでPi Durableを実行するかは未確定。** とくにユーザー要件#2に対する適合を優先して比較する。
- Workspace Serviceを独立プロセスにするか、同一プロセス内の論理モジュールにするかは未確定。
- Workspaceの具体的なFile API、Mutation Protocol、バージョン表現は未確定。
- Shellによるファイル変更を必ずWorkspace File API経由にすることは保証できない。
- Pi Durableの公開APIの正確な型、Replay Safe動作、Storage境界などは**使用バージョンを固定してソース／テストで検証する**。以前の会話中に言及したAPI例は実装確定仕様ではない。

## 4. 論理アーキテクチャ

```text
Self-hosted Web UI  [Conversation / Progress First]
  ├─ Conversations / Progress / Projects / Tasks / Workflows
  └─ Optional: Editor / File Explorer / Git Diff / Web Grabber
            |
            v
Application / Control Plane
  ├─ Auth / Machine Registry / Execution Routing / Public APIs
  ├─ Project / User Task / Workflow Definition & Run
  ├─ Agent Run Registry / Progress Projection
  └─ Workspace Boundary (logical)
           |                         |
           v                         v
   Pi Durable Adapter          Workspace / Git Adapters
           |                         |
   Pi Durable Runtime          Remote Worker Protocol
   Conversation / Tasks              |
           |                         v
           +------ ExecutionEnv ----> Worker / Execution Target
                                       ├─ File System / Worktree
                                       ├─ Shell / Tools / File Watcher
                                       └─ Git Repository
```

中央Pi Durableは**検証用の一案**に留める。各Machine側でCore Agentが動く分散配置も評価対象に残す。Runの状態・所有場所を曖昧にしたまま移送を自動化しない。

## 5. Programming Interface — 提案契約（現段階で実装確定ではない）

### 5.1 Workspace API（EditorとAgentの共通アクセス境界）

```ts
interface FileRef {
  workspaceId: string;
  rootId: string;
  relativePath: string;
}

interface FileSnapshot {
  ref: FileRef;
  content: Uint8Array;
  version: string;
}

interface WorkspaceFileApi {
  readFile(ref: FileRef): Promise<FileSnapshot>;
  writeFile(input: {
    ref: FileRef;
    content: Uint8Array;
    expectedVersion: string;
    operationId: string;
  }): Promise<FileMutationResult>;
  applyPatch(input: {
    ref: FileRef;
    patch: FilePatch;
    expectedVersion: string;
    operationId: string;
  }): Promise<FileMutationResult>;
  watch(workspaceId: string, cursor?: string): AsyncIterable<FileEvent>;
}
```

`FilePatch`、`FileMutationResult`、`FileEvent`は**未定義の設計プレースホルダー**。API設計時にエラー型・順序・永続カーソル・競合時の返却値を具体化する。

- PathはRoot相対で正規化し、`..`、symlink、TOCTOUなどを考慮した**Worker側での最終認可**を必須にする。
- `expectedVersion`を用いた条件付き保存を目標にする。Version生成アルゴリズムや原子的適用方式はPoCで決定。
- `operationId`は再送の照合キー。IDがあるだけでExactly-onceは成立しない。
- 外部Shell/Watcher/Git変更はAPI外でも発生し得る。File Eventsを通知し、読み直し・差分検証により整合する。

### 5.2 Agent Runtime Adapter

```ts
interface AgentRunApi {
  start(input: {
    conversationId: string;
    workspaceId: string;
    executionTargetId: string;
    requestId: string;
    message: string;
  }): Promise<{ runId: string }>;
  stop(runId: string): Promise<void>;
  events(runId: string, cursor?: string): AsyncIterable<AgentRunEvent>;
}
```

`AgentRunEvent`は未定義の設計プレースホルダー。Pi Durableの実APIとは異なる**Application向け抽象インターフェース**。内部でConversation/Submission/Watchと結び付ける案を検証する。RunとConversationは必ずしも一対一ではない。

### 5.3 Execution Environment Adapter

```text
Pi Durable Tool Invocation
  -> ExecutionEnv Adapter
     -> Workspace File Operations (read / controlled mutation)
     -> Worker Process Execution (shell)
     -> Results + operation correlation
```

- 可能な限りPi Durableの標準Tool/ExecutionEnvを再利用する。
- ただし標準Toolが条件付き書き込みや権限を保証できない場合は、専用Tool/Adapter/Workspace APIを追加する。
- Shell操作は任意のファイル変更を引き起こし得るため、File APIだけで全変更を完全制御するという保証を置かない。
- 非冪等Toolを安易にReplay Safe扱いしない。副作用の結果不明時は「成功」「失敗」の二値に押し込めない。

### 5.4 Editor Buffer / Git

```text
EditorBuffer (dirty, baseVersion, local content)
  -> Save(expectedVersion)
  -> Workspace File API
  -> Machine File System (source of truth)
  -> Watch Events / Git status & diff
```

GitはWorking Tree / Index / HEADの正本を保持する。初期のGit Adapterは`status`と`diff`を読み取り専用で実装する案。Stage/Commitは権限と原子性を確認後に追加。

## 6. アーキテクチャ不変条件（採用する目標）

| ID | 条件 | 現在の状態 |
|---|---|---|
| INV-01 | Agent Runは認可済みWorkspaceとExecution Targetに関連づく | 設計で採用、未テスト |
| INV-02 | WorkerはFile Mutation時にRootと権限を検証する | 設計で採用、未テスト |
| INV-03 | Version付き書き込みは古い内容を黙って上書きしない | 設計で採用、未テスト |
| INV-04 | Mutation再送時は既存結果を返す／不明結果を照合し、盲目的に再適用しない | 目標、アルゴリズム未決定 |
| INV-05 | Agent Checkpointと外部File Mutationは別トランザクション | 確認すべき制約として採用 |
| INV-06 | UIのProgressは永続化済み実行事実から復元できる | 目標、イベント契約未決定 |
| INV-07 | Editorのdirty Bufferは外部変更によって黙って上書きされない | 設計で採用、未テスト |
| INV-08 | User TaskとPi Durable内部Taskは別のID・ライフサイクルを持つ | 設計で採用 |

## 7. 状態遷移と障害時の責任

### 通常動作

1. UIがConversationでRun開始を要求。
2. Control PlaneがWorkspace/Execution Target/権限を解決し、Run相関IDを生成。
3. Agent AdapterがPi Durableへ提出。Pi Durableが生成・Tool実行状態を管理。
4. Tool実行はExecutionEnv Adapter経由で対象Workerへ到達。
5. Workerが操作・検証・イベントを記録し、結果を返す。
6. Pi DurableがTool結果を永続化。ApplicationがイベントをProgressへ投影。
7. WorkspaceのファイルイベントをEditor/Git表示側へ配信する。

### 障害責務

| ケース | 主たる責任・期待する状態 |
|---|---|
| LLM/Tool Taskの中断 | Pi DurableのTask/ResumeルールとAdapterで扱う |
| Worker切断 | Control Planeが接続状態を追跡、結果不明を保持。Worker再接続後に照合 |
| File書き込み後・結果報告前の停止 | Workspaceが`operationId`と実ファイル状態から結果を照合。判定不能は`UNKNOWN`相当 |
| Editor BufferとAgent変更の競合 | WorkspaceがVersion Conflict、Editorが差分/解決を提示 |
| Shellがファイルを変更 | Watcher/再スキャン/Git状態で検出。イベント欠落を想定 |
| Pi Durable Process停止 | Runtime側の復旧を検証。外部副作用の自動再実行保証とは区別 |
| Machine消失・別Machine再割当 | 同じWorkspace状態へアクセス可能か検証するまで自動フェイルオーバーしない |

## 8. 非機能要件（初期）

- **Security**: 認証済Worker、暗号化通信、最小権限、許可Rootの隔離、実行承認、秘密情報を無制限にWorkerへ配布しない。
- **Consistency**: Snapshot Version、条件付きMutation、外部変更検知、Operation相関・結果不明の扱い。
- **Durability**: Run/Task/Conversationの再開を実証。Pi Durable保存と外部副作用の境界を明示。
- **Observability**: `projectId` / `workspaceId` / `conversationId` / `runId` / `operationId` / `machineId` の相関。UI上のProgressを再構成可能に。
- **Self-hosting**: ローカル・サーバーで再現可能な起動、バージョン固定、バックアップ/復旧方針。
- **Provider**: 認証方式・Model capability・Tool calling・Streamingの差をAdapterへ閉じ込める。非公式OAuth流用は前提にしない。
- **UX**: Conversation/Progressが主画面。Editor・Git Diffは必要時に開く。定量的性能/可用性SLOは未決定。

## 9. リスクと未決事項台帳（最新）

| ID | 未決事項 / 判断対象 | 現時点の仮説 | リスク | 決定トリガー / 必要な証拠 | 当面の扱い |
|---|---|---|---|---|---|
| U-01 | 中央Harness vs 各マシンCore Agent | 両方式を比較 | **高** | 要件#2の解釈確定と2マシンPoC | 配置中立のAdapter境界を維持 |
| U-02 | Pi Durable API/Storage/再開の実際 | 固定バージョンを使う | **高** | 使用版のソース/Conformance/再起動試験 | 実APIを断定せずPoC |
| U-03 | Worker認証・Shell隔離 | 最小権限+Sandbox | **高** | Remote Tool公開前の脅威モデルと拒否テスト | 安全なread中心のPoC |
| U-04 | File Mutation原子性・冪等性 | Version + operationId + 照合 | **高** | Crash injection / 同時編集テスト | Exactly-onceを主張しない |
| U-05 | Model Provider/ChatGPT OAuth等 | 正式に利用可能な方式に限定 | **高** | Provider実装直前のAPI/利用条件確認 | 一般APIキーで先行PoC |
| U-06 | `commandgode`の実体 | 未確認 | 中 | 当該Providerの要件化前 | 名称保留 |
| U-07 | UI/Editor実装ライブラリ | React + Monaco等候補 | 低 | UI/Buffer PoC | 見た目より契約を優先 |
| U-08 | Editor Buffer永続化・同期 | ローカルdirty Buffer分離 | 中 | ブラウザ再起動・通信断・競合試験 | 暗黙上書き禁止 |
| U-09 | Workflow Graph形式 | Versioned graph / DAG案 | 中 | Workflow実装開始前 | 定義と実行を分離 |
| U-10 | Git Diff Viewerの範囲 | status/diff read-onlyから | 低 | Git PoC | Wantとして後続 |
| U-11 | Web UI Grabberのデータと権限 | 明示Capture＋Preview＋Consent | 中 | Extension PoC | Wantとして分離 |
| U-12 | チーム利用とRBAC | 初期は単一ユーザー仮説 | 中 | 外部共有・公開前 | パブリックアクセスしない |
| U-13 | Progress Event schema / replay | 永続イベントから復元 | 中 | Pi Durable Watchの適合テスト | UI投影を正本にしない |

判断責任者は現時点ではユーザー（プロダクト・技術方針）。期限は日時ではなく表のトリガーで管理。高リスク項目は関係実装の着手前に再判定する。

## 10. PoC計画と合格基準

| 試験 | やること | 合格条件 / 証跡 |
|---|---|---|
| T-01 ExecutionEnv Conformance | 使用版のPi Durable ExecutionEnv適合テスト | 結果、パッケージ版、実API記録 |
| T-02 Workspace Access | 認可Root内でread、Root外/path traversal/symlink逸脱を試す | 正常read成功、逸脱は拒否、監査可能 |
| T-03 Version Conflict | Editor BufferとAgentが同一Fileを異なるVersionから編集 | stale write拒否、dirty Buffer保持、差分提示可能 |
| T-04 Crash/Mutation | 書き込み前後・応答前にプロセス停止 | 重複適用せず結果を復元またはUNKNOWNとして照合可能 |
| T-05 Worker Connection | 2 Machine、切断・再接続・再送・停止 | 対象Machineの同定、結果不明の保持、誤成功なし |
| T-06 Durable Conversation | Pi Durableの会話・Tool Taskを停止/再起動 | 保存済み状態から再開結果を説明・記録可能 |
| T-07 Progress Projection | UI切断・再接続時にイベントを再投影 | 永続化済み事実と一致し、欠落を検知可能 |
| T-08 Provider Compatibility | 最小2種の正式API方式でTool/Streaming | 両方で機能・能力差・失敗を記録 |
| T-09 Git Readonly | WorkspaceのGit status/diffを取得 | 外部Shell変更が差分へ反映される |

> **試験の実施状況：未実施。** 本書は設計と検証計画の統合であり、成功結果を主張しない。

## 11. 工程ゲート判定票

- **対象工程**: 要件定義 → 基本設計 → 境界に限定した詳細設計・PoC
- **判定案**: **Go with Conditions**（設計境界）。実装全体への無条件Goではない。
- **進めてよい**: ADR-001を前提にWorkspace概念モデル、実際のExecutionEnv API調査、Adapter PoC、権限境界/Mutation/復旧の検証設計。
- **保留する**: 本番用の自動Worker移送、フル権限Shell公開、全Provider OAuth統合、Workflow Engineの全詳細、Editor外観の固定。
- **条件**: Pi Durable使用版とAPI適合確認。Worker認可/Root隔離が未完成のまま危険なToolを公開しない。外部副作用のExactly-onceを保証しない。
- **再判定トリガー**: T-01〜T-06の結果、または境界を破る新要件・Pi Durable API変更。
- **中止/見直し条件**: ExecutionEnvの制約で必要な操作が安全に実装できない、ファイル競合を検出できない、PoCが要件#2を満たさない、回復時に許容不能な副作用が発生する。
- **未確定**: 正式な承認者・承認日・期間・コストはまだ記録されていない。

## 12. 次の一手（具体的な順序）

1. **Pi Durableの採用候補バージョンを固定してAPIと適合テストを確認**：`ExecutionEnv` の実メソッド、Storage、Tool replay/cancel、Watchを記録する。
2. **Workspace Execution Contract v0.1**：`FileRef`、Error taxonomy、Version semantics、Mutation result/UNKNOWN、Watch cursor、Worker認可、Run-to-Workspace bindingを詳細化する。
3. **T-01/T-02**：最小WorkspaceでPi Durableから安全なread/execを動かす。
4. **T-03/T-04**：AgentとEditorの同時編集・中断再開を故障注入で検証。
5. **T-05/T-06/T-07**：2 Machine・状態復旧・Progress投影を検証し、中央/分散Harness方針を比較する。
6. 結果に基づきADR、未決事項、MVP範囲、Gate判定を更新する。

## 13. 参照元と継承関係

### ユーザー提供資料

- `agentics_report.md` — Agentic AI、Harness/Loop/Graph/Contextの背景整理
- `agent_engineering_report.md` — モデルの重みを変えないエージェントシステム改善層
- `new_system_development_process(1).md` — 段階的確定、リスクベース工程ゲート、未決事項台帳
- `product_system_design_agent_playbook_ja(1).md` — 既存技術再利用、体験・概念・構成の全体像、根拠の区分、状態の外部記録と再開

### 既存設計と公開一次資料（本書では実装試験の証拠としない）

- `requirements-design-v0.1.md`、`requirements-design-v0.2.md` — 先行要件・PoC・リスク台帳
- Pi Durable: https://github.com/earendil-works/pi/blob/main/packages/durable/README.md
- Pi Mono: https://github.com/badlogic/pi-mono
- Zed Development: https://zed.dev/docs/development
- Zed Remote Development: https://zed.dev/docs/remote-development
- Zed Source: https://github.com/zed-industries/zed

### 記録の取り扱い

- **ユーザー指定**: 最終11要件、ZedはProgramming Interface重視、Conversation/Progress First。
- **設計上の採用**: ADR-001の論理分割、Application/Workspace/Pi Durableの所有権分離。
- **仮説**: 中央Harness配置、技術スタック、File Mutationの方式、MVP範囲、Provider接続の具体性。
- **検証済みではないこと**: Pi Durableと独自Workspaceの統合、Worker 2台接続、障害復旧、競合制御、各OAuth認証の実動作。

## 14. 変更履歴

- **v0.1**: 8要件を中心とする分散Agent Platformの初期構想・PoC。
- **v0.2**: Editor（Must）、Git Diff Viewer（Want）、Web UI Grabber（Want）を追加。
- **v0.3**: **Zed外観/Editor Firstを撤回**。Conversation/Progress Firstへ修正。Workspace→File API・Editor Buffer・Agent File Operations・Gitの関係を並列アクセスモデルとして整理し、**ADR-001（WorkspaceとPi Durableの論理責務分離）**を設計ベースラインに採用。根拠/推論/未検証の区別、Invariant、APIの仮契約、障害責任、ゲート状態を統合。
