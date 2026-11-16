# RLM L2 実装方式の調査

2026-11-17 / 調査（L1 合意済みを前提に、L2 の実現イメージと要素別候補を比較）
関連: [RLM ハーネス実現可能性調査](rlm-harness-feasibility.md)（L0〜L3 の定義、E-01〜E-42、S0〜S4）

> **注**: L1 / L2 は本調査の分析ラベルであり、製品の名前ではない。実装では段階名を使わない。

L1（code-first + subagent）は採用済み。本調査は **L2（忠実な RLM）** を hns で実現する場合に、
必要な要素を分解し、それぞれ複数候補を比較して、参照アーキテクチャ・データモデル・段階計画まで落とす。
結論は「**CPython 常駐カーネルをマシンで動かし、JSONL で制御し、bwrap + no-net + lease で閉じ、
サブ LLM は gateway の stateless 面に出す**。Monty は有力な代替（言語 sandbox + 可搬スナップショット）だが、
Python サブセットの制約がある」。L2 の最小形は **CPython カーネル + context ハンドル + llm_query/batch + answer** で、
子 RLM・スナップショット・複数マシン移行はその次に置く。

---

## 0. 要旨

### 0.1 L2 の推奨形（要約）

| 要素 | 推奨 | 代替 |
| --- | --- | --- |
| 実行ランタイム | **マシン上の CPython + 自前 JSONL REPL** | Monty（サブセット・可搬スナップショット）、ipykernel |
| 分離 | **bwrap（`--unshare-net` 既定）+ cgroup/rlimit + hide** | Monty の言語 sandbox、gVisor（将来） |
| 配置 | **会話ごとのカーネル**を、workspace lease を持つマシンに固定 | workspace 単位、マシン単位 |
| コンテキスト | **workspace に実体を置き（R2 は退避）、`context` ホストオブジェクトで範囲読み・grep** | 文字列を変数に注入、読み取り専用 mount |
| サブ LLM | **machine → gateway の stateless completion**（鍵は gateway のみ） | Session DO の内部 RPC、子会話 |
| 並列 | `llm_batch` を自前 semaphore（既定 4）で 1 ホスト関数に閉じる | `Promise.all`、子タスク |
| 再帰 | `rlm_query` = **子会話 + 子カーネル**、深さ既定 1・最大 2 | mini-agent task、非同期 spawn |
| 状態 | **変数は best-effort、JSON store とファイルは durable** | dill/cloudpickle、Monty snapshot |
| 終了 | **answer doc + `ready` + terminate**（読み出し経路を同時に作る） | 最終メッセージ、構造化出力 |
| UI | プログラムカード、カーネル状態、子一覧、費用、停止 | ノートブック、ターミナル |

### 0.2 最初に作るもの（L2 minimal）

1. **CPython カーネル**（1 会話 1 プロセス、JSONL、bwrap、no-net、cgroup/rlimit、180 秒/セル）。
2. **`python_repl` ツール**（pi-durable の tool 1 個。モデルにはこれだけ見せる）。
3. **`context` ハンドル**（大きい入力は workspace に実体化、R2 は退避。`read/grep/lines/chunks/stat`）。
4. **`llm_query` / `llm_batch`**（gateway の stateless 面、usage 返却、semaphore、上限）。
5. **answer 契約**（`answer` doc + `submit()` で terminate、UI/GraphQL の読み出し）。
6. **失敗時の明示**（カーネル死 → 変数喪失をモデルと UI に伝える。黙って空で続けない）。

子 RLM・スナップショット・複数マシン移行・ストリーミング UI は L2 full に回す。

**呼び方**: 本調査では、再帰なしの最小形を **L2a（L2 minimal）**、子 RLM・snapshot・複数マシンまで含む形を **L2b（L2 full）** と呼ぶ。厳密な L2 は L2b だが、価値の大半は L2a で出る。

### 0.3 最大の設計課題（先に潰す）

| # | 課題 | なぜ重要 | 本調査の答え |
| --- | --- | --- | --- |
| C1 | DO → machine → DO の再入 | Session DO がセル応答を待つ間に、カーネルから同じ DO へサブコールが来ると、直列化・入力ゲートで待たされる可能性 | サブコールは **Worker の内部モデル面 → gateway（service binding）**。DO へはセル終了時に usage を返す |
| C2 | 状態の durable 範囲 | 変数まで durable にすると pickle・サイズ・秘密の穴 | 変数は best-effort。**JSON store + ファイル**を durable にする |
| C3 | egress と秘密 | bash は外向き可、hide 未配線。L2 は「静かな持ち出し口」を増やす | `--unshare-net` を既定、gateway だけを出口、hide を配線、承認 |
| C4 | サブコールの課金 | 現行 gateway は定額・usage 不可視 | gateway に stateless completion と usage 解析を足す |
| C5 | 0147/0194 依存 | カーネルは machine agent の新機能。0147 は read/stat/list のみ、exec/write は 0194 | 0194 の後に `/kernel/*` を足す。同期 180 秒 → 必要なら非同期 job |

### 0.4 どの案を選ぶか（判断表）

| 狙い | 選ぶ案 | 理由 | 目安 |
| --- | --- | --- | --- |
| フル Python のデータ分析・既存資産を使う | **CPython L2a** | pandas/numpy・C 拡張・モデルの慣れ。Linux + bwrap が前提。0194 完了後 | 3〜4 か月（0194 込みで 4〜6 か月） |
| 早く安全に出したい / macOS・Windows も対象 | **Monty L2a** | 言語 sandbox、可搬 snapshot、Python 不要。サブセット | 2〜3 か月 |
| まず価値を測りたい | **L1 + 小さな追加** | カーネルを作らず、context ツールと llm_query だけを足す | 3〜5 週間 |
| 完全な RLM（子再帰・可搬状態） | **CPython/Monty L2b** | L2a + 子 RLM + snapshot + 複数マシン | 6 か月〜 |

**本調査の推奨**: まず **L1 + 小さな追加** で「context を窓の外に置く」「llm_query をコードから呼ぶ」の価値を測り、
必要なら **CPython L2a** に進む。Monty は「早く・安全に・クロスプラットフォーム」を優先する場合の第一候補。
どの案も KernelBackend の裏に置けるので、後から替えられる。

---

## 1. L2 の定義と成功条件

### 1.1 L0〜L3 の再掲

| 段階 | 定義 | hns の対応 |
| --- | --- | --- |
| L0 | context offloading。入力はファイル、モデルは read/bash | 既存 |
| L1 | code-first。コード実行 1 ツール、PTC、同期 subagent、JSON store | 合意済み |
| **L2** | **永続 REPL 名前空間、prompt-as-variable、`llm_query`/`llm_batch`、answer、再帰、sandbox** | 本調査 |
| L3 | RLM で訓練されたモデル | 対象外 |

### 1.2 L2 の必須要素

1. **コンテキストの外部化**: 長い入力をモデルの窓に入れない。モデルはメタデータだけを見る。
2. **永続実行環境**: 変数・import・関数がセルを跨いで残る。プロセスが生きている間だけでもよい。
3. **プログラム的ツール**: ファイル・bash・サブ LLM をコード内の関数として呼ぶ。
4. **サブ LLM**: コードから単発・並列で呼ぶ。結果は窓に戻す前に要約・選別できる。
5. **再帰**: 子 RLM を起動し、子の最終回答だけを親に返す。深さ・本数を制限する。
6. **answer 契約**: 回答を変数に育て、`ready` で終了する。途中経過が残る。
7. **分離**: モデル生成コードは sandbox で走り、秘密・ネットワーク・ホストに直接触れない。
8. **予算**: 実行ツリー全体のトークン・回数・時間・深さを閉じる。

### 1.3 成功シナリオ（10MB の障害ログ）

1. 利用者が 10MB のログを会話に添付する。Worker が R2 に置き、実行時に workspace へ実体化する。会話には `context` のメタデータ（名前・サイズ・先頭 500 文字）だけが入る。
2. モデルは `python_repl` で `print(context.stat())`、`context.grep("ERROR", limit=50)` を実行する。
3. モデルはログを 50 チャンクに切り、`llm_batch` で「この区間の最初の異常を 3 つに絞れ」を並列実行する（同時 4）。
4. モデルは結果を `answer` に育て、`submit()` で終了する。UI には回答・コードセル・子呼び出し・費用が出る。
5. 利用者はセルを展開して根拠を確認し、追加質問する。変数はカーネルに残っている。
6. マシンが落ちた場合、次のセルで「変数は失われた。store とファイルから作り直せ」と明示され、黙って空の名前空間で続かない。

これが「hns で L2 が動く」の意味である。フル Python のデータ分析（pandas/numpy）は CPython 版で、テキスト処理中心なら Monty 版でも成立する。

### 1.4 非目標（今回決めない）

- ノートブック UI、セル履歴の完全な再実行、Jupyter 互換。
- 無人の自律モード、長期 memory、refine。
- マルチテナントの hostile code 実行（個人の開発マシンが前提）。
- macOS/Windows の CPython sandbox（bwrap が無い。Monty/Pyodide の領域）。

---

## 2. 参照アーキテクチャ

### 2.1 全体像

```text
Browser ── GraphQL / WS ──▶ Worker（認証・ルーティング）
                              ├─▶ Session DO（pi-durable）
                              │     ├─ 会話・run・answer doc・kernel record
                              │     ├─ python_repl tool（1 個）
                              │     └─ 署名付き HTTP ──▶ cloudflared ──▶ Machine Agent
                              │                                              ├─ Kernel Supervisor
                              │                                              │    └─ bwrap ── python3 -m hns.repl
                              │                                              │         （JSONL / stdio）
                              │                                              ├─ Workspace tools（root/lease）
                              │                                              └─ model subcall client（Worker 内部面）
                              ├─▶ Workspace DO（版・lease・Journal）
                              ├─▶ Gateway Worker（provider 鍵・usage・budget）
                              └─▶ R2（context / snapshot）

Kernel ── host_request ──▶ Machine Agent ──▶ Worker（internal model）──▶ Gateway（llm_query/batch）
                                      └────▶ Workspace（read/write/bash）
```

### 2.2 構成要素と責任

| 構成要素 | 責任 | 置き場所 | 既存/新規 |
| --- | --- | --- | --- |
| Session DO | 会話・run・tool 呼び出し・answer doc・kernel record・予算 | Cloudflare DO | 既存 + 拡張 |
| Machine Agent | 署名検証、root 封じ込め、カーネル監督、ツール実行、Worker 内部面（model subcall）の呼び出し | マシン | 0147/0194 + 拡張 |
| Kernel Supervisor | 起動・停止・再起動・孤児回収・cgroup・出力中継 | Machine Agent 内 | 新規 |
| CPython カーネル | 名前空間、実行、interrupt、host_request | マシン（bwrap） | 新規 |
| Workspace DO | 版・lease・Journal・認可 | Cloudflare DO | 既存 |
| Gateway | provider 鍵、stateless completion、usage、budget | Cloudflare Worker | 既存 + 拡張 |
| R2 | context の退避、snapshot、大きい出力 | Cloudflare R2 | 既存 |
| UI | プログラムカード、カーネル状態、子、費用、停止 | Web | 新規 |

**現状（2026-11-17）**: `@hns/machine` は 0147 で入り、`POST /rpc` の `health` / `stat` / `read` / `list` だけを答える。
書き込みと exec は 0194、署名付きの exec はその後である。カーネルの `/kernel/*` は、この 3 つの後続になる。

### 2.3 なぜマシンか、なぜ CPython か

- **マシン**: D047 の「Cloudflare は計算を持たない」。カーネルはファイル・git・bash と同じ場所で動く必要がある。CF Sandboxes/E2B はこの前提を壊す。
- **CPython**: L2 の価値の中心は「Python でログ・データ・リポジトリを操作する」こと。Monty はサブセットで、pandas/numpy・C 拡張・`yield`・`@property` が無い。CPython は起動 13ms・セル 1ms 未満（実測）で、対話速度も十分。
- **自前 JSONL**: Jupyter は起動 406ms、ZMQ/5 チャネル/署名の運用が増える。prime-agent の protocol v3 を縮小すれば、fd 分離・interrupt・出力上限を hns の監査方針に合わせられる。
- **Worker 内部面 + gateway**: DO 再入を避け、鍵を 1 か所に閉じる。Machine Agent は Worker の `/internal/model/subcall` を device key で署名し、Worker が gateway を service binding で呼ぶ。usage はセル結果で DO に返す。

### 2.4 カーネル抽象（CPython / Monty / QuickJS を差し替える）

```ts
export interface KernelBackend {
  start(input: KernelStart): Promise<KernelHandle>;
  exec(handle: KernelHandle, code: string, options: ExecOptions): AsyncIterable<KernelEvent>;
  interrupt(handle: KernelHandle): Promise<void>;
  close(handle: KernelHandle): Promise<void>;
  snapshot?(handle: KernelHandle): Promise<Uint8Array>;
  restore?(handle: KernelHandle, bytes: Uint8Array): Promise<void>;
}

type KernelEvent =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "result"; text: string }
  | { type: "host_request"; id: string; request: HostRequest }
  | { type: "done"; status: "ok" | "error" | "timeout" | "interrupted"; ms: number }
  | { type: "error"; name: string; message: string; traceback?: string };
```

- `cpython`: プロセス + JSONL。`snapshot` は無し（v1）。
- `monty`: セッション + host functions。`snapshot/restore` あり。
- `quickjs`: L1 の code mode。`exec` は 1 スクリプト。

この抽象があると、L2 のモデル向け API（`python_repl`、`answer`、`context`）を保ったままバックエンドを替えられる。

### 2.5 データモデル

```ts
/** 会話ごとのカーネル。Session DO の document。 */
interface KernelRecord {
  conversationId: string;
  machineId: string;
  backend: "cpython" | "monty" | "quickjs";
  status: "starting" | "running" | "idle" | "stopped" | "lost";
  epoch: number;            // workspace lease の epoch
  generation: number;       // カーネル再作成のたびに増える
  lastSeq: number;          // セルの通し番号
  snapshot?: { key: string; hash: string; bytes: number; version: string };
  startedAt: string;
  updatedAt: string;
}
```

```ts
/** 大きい入力のハンドル。本文は workspace（R2 は退避・snapshot 用）。 */
interface ContextHandle {
  id: string;
  kind: "attachment" | "workspace-file" | "transcript" | "inline";
  name: string;
  mime: string;
  bytes: number;
  version?: string;         // workspace の版
  preview: string;          // 先頭 500 文字だけ
}
```

```python
# カーネルに注入される API（モデルが書くコードから見える）
context.stat()                 # {"bytes": ..., "lines": ..., "name": ...}
context.read(offset, length)   # str
context.grep(pattern, limit=50) # [{"line": n, "text": "..."}]
context.lines(start, end)      # str
context.chunks(size, overlap=0) # iterable[str]

tools.read_file(path)          # JSON: {"ok", "content", "version"}
tools.write_file(path, content, expected_version)
tools.bash(command)            # JSON: {"exitCode", "output", "truncated"}

llm.query(prompt, model=None)  # str
llm.batch(prompts, concurrency=4)  # list[str]

answer.set(content)            # 途中経過を更新
answer.ready = True            # 次のセル境界で終了
submit()                       # terminate（answer.ready と同義）
```

### 2.6 通信と実行の流れ

**セル実行（v1: 同期 HTTP）**

1. モデルが `python_repl(code)` を呼ぶ。pi-durable は tool task を作る。
2. Session DO は `POST /kernel/exec`（署名、jobId、conversationId、code、timeout=180s）を Machine Agent に送る。
3. Machine Agent はカーネルの stdin に JSONL で `execute` を書く。stdout のイベントを SSE で Worker → DO → UI に流す。
4. カーネルが `host_request`（context/tools/llm）を出す。Machine Agent が処理する。
   - context: workspace の実体から読む（R2 は起動時にコピーするか署名付き URL で読む）。
   - tools: Workspace の版・lease を確認して実行する。
   - llm: gateway の stateless completion を呼ぶ（DO を経由しない）。
5. カーネルが `done` を返す。Machine Agent は `{status, stdout, result, usage, hostCalls}` を返す。
6. DO は tool result を commit し、usage を tree budget に加算する。モデルは次のセルを書く。

**サブ LLM（Worker 内部面 + gateway）**

```text
kernel.llm.query(prompt)
  → host_request {type:"llm.query", requestId, model, prompt}
  → Machine Agent
  → POST Worker /internal/model/subcall（device key 署名, idempotency key）
  → gateway service binding → provider
  → {text, usage}
  → kernel
```

- 鍵は gateway のみ。カーネルと Machine Agent は provider 鍵を持たない。Machine Agent は **device key**（秘密はマシン、0600）で Worker の `/internal/model/subcall` に署名し、Worker が gateway を service binding で呼ぶ。gateway は route allowlist と budget だけを持つ。

```http
POST /internal/model/subcall
{ "requestId": "...", "model": "...", "messages": [...], "maxTokens": 2048 }
→ 200 { "text": "...", "usage": { "input": 1234, "output": 567, "costUsd": 0.004 }, "model": "..." }
→ 4xx/5xx { "code": "budget_exceeded" | "model_not_allowed" | "upstream" , "message": "..." }
```
- gateway は usage を解析し、日次/月次のトークン予算と金額を更新する。`requestId` で冪等。
- DO はセル結果の `usage` で木の合計を更新する。gateway は全体の金額天井で、木の予算は DO と Machine Agent がセル単位で閉じる。

**answer と終了**

1. カーネルが `answer.set(...)` / `answer.ready = True` を実行する。
2. Machine Agent はセル結果に `answer` を含める。
3. DO は answer doc を commit し、`submit()` なら `control:{terminate:true}` を返す。
4. run は追加のモデル要求なしで終了する。**`lastAssistantText` はその run の answer ではなく、直前の本文 assistant を返し得る**（ツール呼び出しだけの assistant は飛ばされる）。answer は tool result / answer doc から読む専用経路が必須。

**復旧**

| 事象 | 扱い |
| --- | --- |
| DO eviction | カーネルはマシンで生存。DO は KernelRecord を読み、同じ generation に再接続。実行中セルは `unknown` として status 照会 |
| アイドル停止 | `status: "stopped"`。次のセルで新カーネルを起動し、「変数は失われた」と明示する（`lost` と同じ扱い） |
| Machine Agent 再起動 | 子カーネルは死ぬ（`--die-with-parent`）。DO は `lost` にし、次のセルで新カーネル。変数喪失を明示 |
| マシン喪失 | lease 失効。新マシンで新カーネル。store とファイルから再開。変数は戻らない |
| カーネルクラッシュ | supervisor が 1 回だけ再起動。同じく変数喪失を明示 |

### 2.7 DO 再入（重要な設計判断）

Session DO が Machine Agent のセル応答を `await` している間に、カーネルの `llm.query` が同じ Session DO に戻ってくると、
DO の直列化・入力ゲートでその要求が待たされ、セルが終わらない → デッドロックに近い状態になり得る。
これは実測していないが、設計で避けるべき形である。

| 案 | 仕組み | 評価 |
| --- | --- | --- |
| **A: Worker 内部面 + gateway（推奨）** | カーネル → Machine Agent → Worker（device key 署名）→ Gateway（service binding）→ provider。DO はセル終了時だけ関与 | 再入なし。鍵は gateway。gateway は公開しない。usage は遅れて DO に返る |
| B: DO 内部 RPC | カーネル → Machine Agent → Worker → Session DO | usage は正確。**再入の危険**。非同期 job + callback か別 DO が要る |
| C: 子会話 | カーネル → 子会話 → 子カーネル | 再入なし。重い。`rlm_query` 用 |
| D: カーネルに鍵 | カーネル → provider 直 | 鍵が sandbox に入る。**不採用** |

**認証と予算の現実**: 現在の gateway は route を持たず、Session DO からの service binding だけを受ける（[docs/auth.md](../../docs/auth.md)）。
Machine Agent は Worker の `/internal/model/subcall` に **device key の署名**を付け、Worker が D1 の Machine 公開鍵で検証してから gateway を service binding で呼ぶ。
gateway を公開 route にするのは 0160 以降で、そのとき呼び出し元認証を同時に足す。
現行 budget は**単一グローバル行の USD 定額**なので、実行ツリーの予算を gateway だけで閉じることはできない。
実行ツリーは **DO がセル単位で**、セル内は **Machine Agent が max calls / maxTokens** で閉じる。gateway は全体の金額天井（最後の砦）である。

A を採ると、サブコールの予算は gateway（全体の金額）と DO（木の合計）の二段になる。
DO はセル結果の usage を commit するので、1 セル分の遅れは許容する。セルが crash した場合は gateway の記録と DO の記録がずれるため、
`requestId` で照合できるようにする（未確定分は `unknown` として次回に足す）。

### 2.8 セキュリティ境界

```text
model code
  └─ bwrap: root のみ書込、/ は ro、--unshare-net、--clearenv、hide
       └─ CPython（venv はプロジェクトのもの）
            ├─ context: workspace の実体（範囲指定）
            ├─ tools: Workspace の版・lease を経由
            └─ llm: gateway のみ（provider 鍵なし）
```

- **能力は host 関数だけ**。カーネルはネットワーク・環境変数・provider 鍵を持たない。
- **書き込みは Workspace の版・lease を通す**。カーネル内の `open(..., "w")` は root 内だが U（Run 終了まで durable でない）。プロンプトで `tools.write_file` を推奨する。
- **bash は host 関数**。**0194 で入る** Machine Agent の sandbox で実行し、カーネル内の `subprocess` は使わせない（二重の sandbox を避ける）。**bash も同じ no-net ポリシー**で実行する。ここを開けると、カーネルの no-net を bash 経由で迂回できる。
- **workspace 内の `.env` など**は `tools.read_file` で読める。完全には防げないので、秘密スキャン・承認・監査を組み合わせる（3.12 節）。
- **承認**: 書き込み・bash・network を要する操作は `beforeTool` で止められる。初期は「事後監査 + abort」でもよいが、L2 では承認を推奨。
- **監査**: セルは `cell.exec`（callId、所要、成否、出力バイト、usage）だけをイベントに残す。コード本文は transcript の tool 引数にだけ置く。子 LLM のプロンプト・応答本文はイベントに残さない。
- **スナップショット**: CPython は v1 で取らない。Monty は HMAC + 版一致 + 信頼できる保存先のみ。

---

## 3. 要素別の候補比較

スコアは **High が良い**。実装は「低コストほど High」。hns は D047・fail closed・`(C,J)`・鍵は gateway、を基準にする。
14 要素・約 80 候補を、上の基準で横並びにしている。

### 3.1 実行ランタイム

| 候補 | Python 互換 | 状態保持 | 起動 | 安全 | hns 適合 | 実装 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **CPython + 自前 JSONL** | **完全** | プロセス生存中 | **13ms**（実測） | bwrap 次第 | **High** | Med | **第1案** |
| CPython + ipykernel | 完全 | プロセス生存中 | 406ms（実測） | bwrap 次第 | High | Med | 代替（Jupyter 資産が要るとき） |
| **Monty** | **サブセット**（C 拡張なし） | セッション + snapshot | <1ms（ベンダ） | **言語 sandbox** | High（ただし制約） | Med | **有力な代替** |
| Pyodide | WASM wheel のみ | Worker 生存中 | 重い（ベンダ 2700ms/10 セル） | WASM | Low（D047 と重い） | Med | 不採用（v1） |
| RustPython | 純 Python 概ね | プロセス生存中 | 中 | プロセス | Med | Low | 不採用 |
| Node/TS 常駐 | なし | プロセス生存中 | 20ms | bwrap/権限 | High（JS のみ） | High | L1 の延長 |
| QuickJS（pi-codemode） | なし | 実行ごとに破棄 | 高速 | **強** | High | High | L1 |
| CF Sandboxes / E2B / Daytona | 完全 | コンテナ/VM | ベンダ次第 | 強 | **Low（D047）** | Med | 不採用（既定） |

**推奨**: CPython を主、Monty を「Python が無い/サブセットで足りる/可搬スナップショットが欲しい」場合の代替。
QuickJS は L1 のまま残す。CF/E2B は「マシンを持たない利用者向けの任意バックエンド」としても、既定にはしない。

**Monty の実測（本機、Node 24.22.2、@pydantic/monty 1.6.0）**:

| 項目 | 結果 |
| --- | --- |
| セッション状態 | `x=21` → 次セル `x*2` = 42 |
| 非同期 host 関数 | `await add(2,3)` = 5 |
| session dump / load | 小状態 1,117 bytes。別セッションで復元し `x+1` = 22 |
| 1MB 文字列の dump | 1,001,061 bytes（約 1:1） |
| 500ms 制限の無限ループ | `MontyRuntimeError: TimeoutError` |
| `open("/etc/passwd")` | `PermissionError` |
| `import numpy` | `ModuleNotFoundError` |

→ Monty は「テキスト処理 + 限定ライブラリ」の L2 には十分。データ分析・C 拡張は CPython。

### 3.2 分離方式

| 候補 | 強さ | net 遮断 | 秘密 hide | 起動 | 配備 | hns 適合 | 判定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **bwrap（既存）** | Med | **可**（実測 Errno 101） | 可（tmpfs） | +4ms | 既存 | **High** | **第1案** |
| **Monty 言語 sandbox** | High（capability なし） | 構造的に無し | 不要 | <1ms | npm | **High** | Monty 用 |
| nsjail | High | 可 | 可 | 数 ms | 追加バイナリ | Med | 代替 |
| gVisor | High | 可 | 可 | 構造的コスト | runsc | Low | 将来（多租户） |
| Firecracker | High | 可 | 可 | 60〜125ms | KVM/root | Low | 将来 |
| Docker/Podman | Med | 可 | 可 | 195ms | デーモン | Low | 不採用 |
| CF Sandboxes | High | 可 | 可 | コンテナ | CF | **Low（D047）** | 任意 |
| E2B/Daytona/Modal | High | 可 | 可 | ベンダ | SaaS | Low | 任意 |
| WASM（QuickJS） | High | 無し | 不要 | 高速 | npm | High | L1 |
| Node vm / isolated-vm | Low/Med | 不可 | 不可 | 0 | npm | Low | 不採用 |
| 分離なし | Low | 不可 | 不可 | 0 | — | Low | 不採用 |

**推奨**: bwrap + `--unshare-net` + `--clearenv` + hide + cgroup/rlimit。Monty は言語 sandbox を主、bwrap を defense-in-depth に使う。
gVisor/Firecracker は「他人のコードを多数実行する」段階まで採らない。
サンドボックス基盤（E2B/Daytona/Modal/CF/Fly 等）の比較は [agent-sandbox-designs.md](agent-sandbox-designs.md) に詳しい。

### 3.3 プロトコル / トランスポート

| 候補 | ストリーム | 割込 | 順序 | 再接続 | 実装 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| **JSONL over stdio** | ○ | ○（SIGINT） | 厳密 | プロセスと共に死ぬ | Med | **CPython 第1案** |
| **Monty host functions** | ○（print callback） | ○（timeout/kill） | セッション | snapshot | Med | **Monty 第1案** |
| Jupyter ZMQ | ○ | ○ | msg 単位 | △ | High | 代替 |
| Jupyter WS | ○ | ○ | msg 単位 | ○ | Med | 代替 |
| HTTP/SSE（セル=1 要求） | ○ | 別要求 | クライアントが直列化 | ○ | Low | **DO↔machine 第1案** |
| WebSocket 独自 | ○ | ○ | 自前 | ○ | Med | L2 full |
| MCP | △ | △ | セッション | ○ | Low | 不採用 |

**推奨**: カーネル内部は JSONL（CPython）/ host functions（Monty）。DO↔Machine は **署名付き HTTP（セル 1 要求、SSE で出力）**。
セルが 180 秒を超える/ストリーミングを強化する段階で、**非同期 job + callback** か WS に移す。

### 3.4 コンテキスト注入

| 候補 | 長所 | 短所 | 判定 |
| --- | --- | --- | --- |
| 文字列を変数に注入 | 単純。モデルがそのまま使える | 10MB でメモリ・プロンプト転送・スナップショットが重い | 小入力のみ |
| **ファイル + `context` ハンドル** | メモリ一定、範囲読み、grep、R2 保存 | 実装（ホスト関数）が必要 | **第1案** |
| R2 range read（署名付き URL 経由） | 大容量、安い | 1 回の hop、キャッシュ必要。Machine は R2 を直接読めない | 将来（L2a は workspace 実体） |
| 読み取り専用 mount | Python の `open` がそのまま動く | 版管理・監査が弱い、ファイル全体が見える | 補助 |
| transcript API | 会話全体をデータにできる | トークン・サイズ・プライバシー | 将来 |
| BM25/vector | 検索が速い | RLM の「コードで探索」と重複 | 不採用（v1） |

**推奨**: `ContextHandle`（workspace 実体 + R2 退避）+ `context` ホストオブジェクト。32KB 以下は文字列で注入してもよい。
モデルのプロンプトには `name/size/mime/preview` だけを入れ、本文は入れない。

**実体の置き方（重要）**: Machine Agent は R2 を直接読めない。L2a では **context の本文をワークスペース（または実行用の一時ディレクトリ）に実体化**してからカーネルを起動する。
R2 は「大きい添付の保管」「snapshot」「出力の退避」に使い、カーネルの読み取り経路には入れない（読むなら Worker の署名付き URL か、起動時のコピー）。

### 3.5 ツール / ホスト関数

| 候補 | 仕組み | 長所 | 短所 | 判定 |
| --- | --- | --- | --- | --- |
| **host_request** | カーネル → Machine Agent の型付き RPC | 能力を 1 か所に閉じる。監査しやすい | 実装（プロトコル） | **第1案** |
| Python モジュール直結 | カーネル内で `tools` を import | 速い | 権限・sandbox が崩れる | 不採用 |
| MCP | 標準 | 既存ツール資産 | セル実行の意味論が無い | 不採用 |
| shell out | `bash` で CLI | 簡単 | 出力・版・監査が弱い | 補助 |

**推奨**: `read_file` / `write_file` / `bash` を host_request で提供。`write_file` は Workspace の版・lease を通す。
`bash` は Machine Agent の sandbox で実行し、カーネル内の `subprocess` は禁止する（二重 sandbox を避ける）。

### 3.6 サブ LLM

| 候補 | レイテンシ | 耐久 | 課金 | 監査 | 実装 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| pi-ai 直（ツール内） | 最小 | 弱（再送で二重課金） | 自前 usage | ツール 1 行 | S | 試作のみ |
| 内部ツール `llm.generate`（CF code mode） | 小 | 強（nested task） | `pi.usage.tools` | nested | S〜M | **L1 用** |
| 自前 `defineTask` | 中 | 最強 | 自前 | task graph | M | 代替 |
| 子会話 | 大 | 強 | 子の usage | 全 transcript | M | **`rlm_query` 用** |
| **Worker 内部面 + gateway** | 中（1 hop） | 中（gateway は状態なし） | **最良（usage 解析）** | gateway ログ | M | **L2 第1案** |
| provider batch | 時間〜日 | 中 | provider | 弱 | L | 不採用 |
| ローカルモデル | 小 | 0147 依存 | 無料 | machine | L | 将来 |

**推奨**: L2 の `llm.query` は **gateway の stateless completion**。`rlm_query` は子会話。L1 の code mode は内部ツール `llm.generate` のまま。
gateway は `requestId` で冪等にし、`usage` を返す。ストリーミングは v1 では使わない。

### 3.7 並列 / バッチ

| 候補 | 上限 | 部分失敗 | 耐久 | 判定 |
| --- | --- | --- | --- | --- |
| `Promise.all`（無制限） | 無し | 全体 reject | 弱 | 不採用 |
| **semaphore 付き `llm.batch`** | 自前（既定 4） | `collect` / `failFast` を選ぶ | 中（1 セル） | **第1案** |
| 子タスクを 1 本ずつ | 自前 | 方針を明示 | 最強 | L2 full |
| 1 ツール 1 タスクで N 本 | 自前 | crash で N 本喪失 | 弱 | 不採用 |
| provider batch | — | — | — | 不採用 |

**推奨**: `llm.batch(prompts, concurrency=4, on_error="collect")` を 1 ホスト関数で実装。各呼び出しに `requestId` を付け、
gateway で冪等にする。部分失敗は結果配列に `{ok, text, error}` で返す。

### 3.8 再帰（子 RLM）

| 候補 | 分離 | コスト | 深さ | 監査 | 判定 |
| --- | --- | --- | --- | --- | --- |
| `llm.query` のみ（深さ 0） | なし | 最小 | 0 | 1 行 | **L2 minimal** |
| 同一カーネル内の関数 | なし | 小 | 0 | 1 行 | 補助 |
| **子会話 + 子カーネル** | あり | 大 | 1〜2 | 子 transcript | **L2 full** |
| 子カーネル（会話なし） | あり | 中 | 1〜2 | 弱い | 不採用（監査） |
| mini-agent task | あり | 中 | 1〜2 | task graph | 代替 |
| 非同期 spawn / message | あり | 中 | 2 | 弱い | 不採用（初期） |

**推奨**: L2 minimal は `llm.query/batch` のみ。L2 full で `rlm_query` を子会話 + 子カーネルとして追加。
深さは会話の agent 設定に持ち、上限で `rlm_query` 拡張を外す。木全体のノード数・トークン・時間で閉じる。

### 3.9 状態 / スナップショット

| 候補 | durable | 復旧 | 安全 | サイズ | 判定 |
| --- | --- | --- | --- | --- | --- |
| メモリのみ | なし | なし | — | 0 | 単独では不成立 |
| **JSON store（DO doc）** | する | 高い | 高い | 1 値 256KiB / 全体 1MiB | **第1案** |
| **ワークスペースファイル** | する | 高い | 高い | 既存 `(C,J)` | **第1案** |
| Monty snapshot | する（版一致） | 高い | 中（HMAC/信頼） | 状態次第（1MB→1MB） | 代替（Monty） |
| dill/cloudpickle | する（同一版） | 低い | **低い（RCE）** | 16MiB/256MiB | 不採用 |
| WAL + リプレイ | する | 高い（決定的なら） | 中 | 小 | 将来（QuickJS） |

**推奨**: 変数は best-effort（プロセス生存中）。`store`（JSON）とファイルを durable にする。
CPython のスナップショットは v1 で取らない。Monty を使う場合だけ、HMAC + 版一致 + 同一ユーザーの snapshot を R2 に置く。

**Monty snapshot の注意**: host object（`context` / `tools` / `llm`）と mount は snapshot に乗らない。復元時に再注入する。
context をホストオブジェクトにしておけば、1MB の入力を Python ヒープに載せず、snapshot を小さく保てる（実測: 1MB 文字列を載せると dump も約 1MB）。
「復旧したら変数が消えた」ことをモデルと UI に明示する（黙って空で続けない）。

### 3.10 ライフサイクル / 複数マシン

| 候補 | 名前空間の単位 | 長所 | 短所 | 判定 |
| --- | --- | --- | --- | --- |
| **会話ごと** | 会話 | 混ざらない。RLM の文脈と一致 | プロセス数 = 深い会話数 | **第1案（上限 2/マシン）** |
| workspace ごと | workspace | lease と粒度が一致。プロセス削減 | 会話間で変数が混ざる | 代替 |
| マシンごと | マシン | 1 プロセス | 全部混ざる | 不採用 |
| 実行ごと | run | 状態なし | L2 の意味が消える | 不採用 |
| warm pool | マシン | 起動が速い | メモリ・sandbox 数 | 将来 |

**推奨**: 会話ごと。workspace lease を持つマシンに固定し、同時 2 カーネル/マシン、アイドル 10 分で停止（`stopped`）。
同じ workspace の 3 本目の deep 会話は、別マシンに逃がさず **429/busy** で断る（lease が 1 台に閉じるため）。待ち行列は作らない。利用者が 1 本閉じるか、後で再試行する。
マシン喪失時は新カーネル + store/ファイル復旧。変数は戻らない。Monty なら snapshot で移せる。

### 3.11 終了契約（answer）

| 候補 | 仕組み | 途中経過 | 失敗時 | 忠実度 | 判定 |
| --- | --- | --- | --- | --- | --- |
| **answer doc + ready + terminate** | `answer.set` / `ready` → `submit` が `terminate` | doc に残る | answer は残る | 最高 | **第1案** |
| 最終メッセージ | 既存 | entry | runFailure | 低 | 補助 |
| 構造化出力 | schema 検証 | 弱い | 検証失敗 | 中 | 補助 |
| workflow 状態機械 | ノード遷移 | 強い | ノード失敗 | 中 | 長期ジョブ |

**落とし穴**: `terminate` で終わる run の最後の assistant はツール呼び出しで、`answer` は tool result と answer doc 側にある。`lastAssistantText` はその run の回答を返さない（直前の本文 assistant を返し得る）。
**answer doc を GraphQL / UI に出す経路を、終了契約と同じ変更で作る**。後回しにすると UI が空になる。

### 3.12 安全

| 対策 | 内容 | 必須度 |
| --- | --- | --- |
| **bwrap no-net** | `--unshare-net` を既定。外すのは会話単位の明示許可 + 監査 | 必須 |
| **hide** | `~/.config/hns` などを tmpfs でマスク。製品側の配線が未完了 | 必須 |
| **鍵を置かない** | provider 鍵は gateway のみ。カーネルは host 関数だけ。Machine Agent は device key を持つ（秘密はマシン、0600） | 必須 |
| **能力モデル** | ツールは host_request のみ。`subprocess`・`open` の直接利用は制限 | 必須 |
| **承認** | write/bash/network は `beforeTool` で承認。初期は事後監査 + abort でも可 | 推奨 |
| **監査** | `cell.exec`（メタのみ）、`llm.query`（回数・トークン・モデル） | 必須 |
| **供給網** | Python はプロジェクト venv / Nix。runtime pip 禁止 | 必須 |
| **snapshot** | HMAC、版一致、信頼ストレージのみ。不信データを restore しない | Monty 時 |

**現状の穴（事実）**: bash は外向き通信が可能（`--unshare-net` が無い）、`hide` は製品コードで未配線、承認機構は無い。
L2 はこれらを**前提**にする。先に閉じないと、`llm.query` が「静かな持ち出し口」になる。

### 3.13 UI / 観測

| 候補 | 長所 | 短所 | 判定 |
| --- | --- | --- | --- |
| **プログラムカード** | 会話の流れを壊さない。コード・出力・子を折りたたみ | 実装（Web） | **第1案** |
| ノートブック | セル履歴・再実行 | 製品の会話 UI と別物 | 不採用 |
| ターミナル | 生の実行 | 監査・UX が弱い | 不採用 |
| 非表示 | 実装最小 | 「何が起きたか」が分からない | 不採用 |
| 変数エクスプローラ | 名前・型・サイズ | 値を出すと秘密・UX | 補助 |
| 費用/トレース | 木の内訳 | 実装 | 必須 |

**推奨**: プログラムカード + カーネル状態（starting/running/idle/lost）+ 子一覧 + 費用 + 停止。
変数は名前とサイズだけ。コードは transcript、イベントはメタのみ。

```text
[assistant] 最初の原因は DB 接続プールの枯渇です。根拠: ...

  ▸ セル 1  context.stat()                 32ms
  ▸ セル 2  context.grep("ERROR")          18ms   12 件
  ▸ セル 3  llm.batch(50 chunks)           9.4s   12.1k tokens
  ▸ 子 1    「chunk 7-12 の異常」           3.2s   2.1k tokens

  [停止] [セルを展開] [変数] 費用 $0.04 / 残り 12k tokens
```

### 3.14 モデル / プロンプト

| 候補 | 長所 | 短所 | 判定 |
| --- | --- | --- | --- |
| **単一 `python_repl` ツール** | ツール定義が小さい。prime-agent と同じ | モデルがコードを書けないと動かない | **第1案** |
| 複数ツール（read/bash/subagent） | モデルに優しい | 文脈・選択ミス・定義トークン | L1 のまま |
| JS code mode | hns と同一言語 | Python 資産なし | L1 |
| モデル別 tips | 効果が大きい（先行調査） | タスク依存・プロンプト肥大 | 検証 |
| 2 段階（計画 → コード） | 弱いモデルに優しい | 遅い | 補助 |

**推奨**: `deep` モードでは `modelTools: [python_repl]`。システムプロンプトに「利用可能な API、Monty/CPython の違い、answer 契約、出力上限、ネットワーク禁止」を書く。
モデル別 tips は V1 の A/B で採否を決める。弱いモデルは `chat` に固定する。

---

### 3.15 なぜ Python 中心か（バイアスの説明）

本調査の短列表が Python 系に偏っているのは事実である。理由は次の 3 つで、**言語中立の比較ではない**。

1. **L2 の参照が Python だから**: RLM 論文・prime-agent・参照実装は Python REPL を前提に、`llm_query` / `answer` / `context` の語彙を定義している。忠実度を測る基準が Python 側にある。
2. **L2 の価値を「長文・データ・リポジトリの解析」に置いたから**: ログ、CSV/JSON、PDF、データフレーム、既存の分析資産は Python が最も厚い。モデルもコードインタプリタとして Python を最もよく書く。
3. **L1 がすでに JS/QuickJS だから**: `codemode` は JS で、永続名前空間は無い。L2 で同じ JS を繰り返すと「L1 の延長」になり、L2 の差分（永続状態・Python 資産・再帰）が出ない。

ただし、この偏りは「L2 の目的を Python 前提に置いた」ことの帰結であり、**言語選択の比較としては不完全**である。フェアに並べるなら、次の候補も同じ基準で評価する必要がある。

| 候補 | L2 適合 | 長所 | 短所 | 現状の判定 |
| --- | --- | --- | --- | --- |
| Python（CPython） | **High** | 完全な資産、モデルの慣れ、実測 13ms | bwrap・プロセス監督・変数は best-effort | 第1案 |
| Python（Monty） | High（制約付き） | 言語 sandbox、可搬 snapshot、Python 不要 | サブセット、C 拡張なし | 代替 |
| Python（Pyodide） | Med | WASM、クロスプラットフォーム | 起動・メモリ・C 拡張・snapshot 無し | 不採用（v1） |
| **JS/TS 常駐（Node）** | Med〜High | hns と同一言語、npm、worker_threads | `vm` は境界にならない。Python 資産なし。bwrap 要 | **再評価候補** |
| **Deno** | Med | 権限フラグ、TypeScript、セキュリティ | 2 つ目のランタイム、npm 互換の穴 | 再評価候補 |
| **Bun** | Med | 高速、Node 互換 | ランタイム成熟度、pi-codemode の既知差 | 保留 |
| QuickJS（pi-codemode） | Low〜Med | 既存、強い sandbox | 永続名前空間なし、実行ごとに破棄 | L1 のまま |
| SQL / DuckDB | 専門 | ログ・CSV の集計が速い、決定的 | 汎用 REPL ではない。状態・再帰が無い | **Python 内のツール** |
| Shell / awk | 低 | 既存 bash、追加 runtime 不要 | 構造化データ・状態・再帰が弱い | bash ツールのまま |
| R / Julia | 低 | 統計・科学計算 | 利用者層が狭い、別 runtime | bash 経由 |
| マルチ言語（Python + bash + SQL） | High | 1 カーネルで用途を分ける | プロトコル・権限が複雑 | **推奨の構成** |

**判断規則**:

- 主な仕事が **Python のデータ・ログ・リポジトリ解析**なら、Python を第一にする（本調査の前提）。
- 主な仕事が **hns 自身や TS リポジトリの操作**なら、Node/Deno の常駐カーネルを第一候補に再評価する。この場合、L2 の「Python 資産」は捨て、「永続状態 + PTC + 再帰」に価値を絞る。
- **SQL/DuckDB はカーネルにしない**。Python カーネル内の `duckdb` モジュール、または独立した「query」ツールとして足す。ログ集計は Python より速く、決定的である。
- **複数カーネルを並べない**。1 つのカーネル + host 関数（bash / SQL / subagent）で足りる。言語ごとにカーネルを立てると、状態・監査・コストが増える。

**結論**: Python 中心は「L2 の目的を Python の長文解析に置いた」ための意図的な重み付けであり、言語選択の結論ではない。
L2 の主目的を「TS リポジトリの永続コード実行」に置くなら、Node/Deno を同じ重さで比較し直すべきである。

## 4. 推奨構成

### 4.1 L2 minimal（CPython）

| 項目 | 決定 |
| --- | --- |
| バックエンド | CPython 3.13+、プロジェクト venv があればそれ、無ければ system（サードパーティは保証しない） |
| プロトコル | JSONL over stdio（`execute` / `interrupt` / `shutdown` から開始） |
| 分離 | bwrap `--unshare-net` + `--clearenv` + hide + rlimit/cgroup |
| 配置 | 会話ごと、workspace lease のマシン、同時 2/マシン（3 本目は 429/busy、待ち行列なし）、idle 10 分で stopped |
| コンテキスト | workspace 実体 + `context` ホストオブジェクト。32KB 以下は文字列。R2 は退避 |
| ツール | `read_file` / `write_file` / `bash` を host_request。書込は版・lease |
| サブ LLM | Worker 内部面 + gateway。`llm.query` / `llm.batch`（同時 4） |
| 再帰 | なし（`llm.query` のみ） |
| 状態 | 変数 best-effort。`store` JSON（1MiB）+ ファイル durable |
| 終了 | answer doc + `submit()` terminate。UI 読み出し経路 |
| セル上限 | 180 秒、出力 64Ki 文字、メモリ 512MiB、pids 256 |
| 監査 | cell.exec / llm.query のメタのみ。コードは transcript |

**L2a でできること / できないこと**

| できる | できない（L2b 以降） |
| --- | --- |
| 10MB ログの grep・分割・要約 | 子 RLM の再帰 |
| リポジトリ横断の調査 | 変数の可搬スナップショット |
| JSON/CSV の加工、`llm.batch` | マシン間のカーネル移行 |
| answer を育てて終了 | ノートブック UI / セル再実行 |
| 停止・再開（変数は best-effort） | pandas/numpy（プロジェクト venv が無い場合） |

**規模感**: カーネル 2〜3 週間、Machine Agent 拡張 3〜4 週間、DO 組み立て 2〜3 週間、context 1〜2 週間、
gateway 拡張 3〜4 週間、UI 4〜6 週間、安全硬化 2〜3 週間。**0194 完了後**に並行して **3〜4 か月**。0147/0194 と gateway の内部面・認証を含めると **4〜6 か月**（粗い見積もり）。

### 4.2 L2 full（追加）

| 項目 | 決定 | 規模 |
| --- | --- | --- |
| 子 RLM | `rlm_query` = 子会話 + 子カーネル、深さ 1（最大 2） | 3〜4 週間 |
| スナップショット | Monty のみ可搬。CPython は同一マシンのみ（任意） | 3〜4 週間 |
| 複数マシン | Monty snapshot で移行。CPython は store/ファイル復旧 | 2〜3 週間 |
| ストリーミング | SSE/WS でセル出力・子の進捗 | 3〜4 週間 |
| モデル tips | タスク別プロンプト、A/B | 1〜2 週間 |

### 4.3 Monty-first の代替

「まず L2 を小さく出したい」「macOS/Windows も対象」「可搬スナップショットが欲しい」なら、Monty を先に選ぶ。

| 項目 | Monty-first |
| --- | --- |
| 起動 | <1ms（ベンダ）、Node 20+ |
| 分離 | 言語 sandbox（FS/net/env なし）+ host functions |
| スナップショット | あり（HMAC/版一致で R2） |
| Python | サブセット（json/re/csv/math/collections 等） |
| 制約 | numpy/pandas/C 拡張なし、`yield`/`@property` なし |
| 向くタスク | ログ・テキスト・JSON・リポジトリ調査 |
| 向かない | データ分析、科学計算、C 拡張 |
| 規模感 | カーネル 1〜2 週間、Agent 2〜3 週間、他は CPython と同じ |

推奨は **CPython 主 + Monty 代替**。ただし Monty の実測が良く、テキスト処理が中心なら Monty-first も合理的。
どちらも `KernelBackend` の裏に置き、会話ごとに選べるようにする。

### 4.4 採用 / 不採用 / 要検証

| 判定 | 要素 |
| --- | --- |
| **採用** | CPython カーネル、JSONL、bwrap no-net、cgroup/rlimit、会話ごと配置、context ハンドル、host_request ツール、Worker 内部面 + gateway subcall、answer doc、プログラムカード、cell/llm メタ監査 |
| **不採用** | dill/cloudpickle、Jupyter/ZMQ（v1）、CF Sandboxes/E2B 既定、Node vm、分離なし、無制限 fan-out、最終メッセージだけの終了、ノートブック UI |
| **要検証** | Monty の実タスク互換、DO 再入（Worker 内部面で回避できるか）、180 秒セルの CF/cloudflared 実測、gateway usage 解析、hide/no-net の製品配線、子 RLM の費用、snapshot のサイズ/復元、モデル互換 |

### 4.5 忠実度マトリクス

| 要素 | CPython | Monty |
| --- | --- | --- |
| context 外部化 | ○ | ○ |
| 永続名前空間（プロセス生存中） | ○ | ○ |
| プログラム的ツール | ○（host_request） | ○（host functions） |
| `llm.query/batch` | ○ | ○ |
| 子 RLM | ○（子会話） | ○（子会話） |
| answer 変数 | ○ | ○ |
| 可搬スナップショット | ×（v1） | ○ |
| フル Python | ○ | ×（サブセット） |
| 言語 sandbox 単体 | ×（bwrap 要） | ○ |
| macOS/Windows | ×（bwrap 無し） | ○ |

## 5. 実測とスパイク

### 5.1 実測済み

| 項目 | 値 | 条件 |
| --- | --- | --- |
| CPython 起動 | 12.0ms | `python3 -c pass` |
| JSONL REPL spawn→ready | 13ms | 自前、5〜7 回中央値 |
| セル往復 | <1ms | 5 セル連続 |
| bwrap 追加 | +4ms | `--unshare-pid/ipc/uts/net`、`--clearenv` |
| Jupyter start→ready | 406ms（初回 736ms） | ipykernel |
| bwrap no-net | Errno 101 | `socket.create_connection` |
| CPython RSS | 13.3MB | 起動直後 |
| Monty session state | x=21 → 42 | Node 24.22.2 |
| Monty async host | 2+3=5 | `externalLookup` |
| Monty dump/restore | 1,117 bytes; 復元 x+1=22 | 小状態 |
| Monty 1MB dump | 1,001,061 bytes | 1MB 文字列 |
| Monty timeout | 500ms で TimeoutError | `while True: pass` |
| Monty open/numpy | PermissionError / ModuleNotFoundError | 制約確認 |

### 5.2 これから測る（K1〜K6）

| # | スパイク | 合格条件 |
| --- | --- | --- |
| K1 | Machine Agent 上で CPython カーネルを起動し、DO から 1 セル実行 | 往復 <500ms、出力・interrupt・終了が正しい |
| K2 | 10MB の context を workspace に実体化し、`context.grep/read` を 100 回（R2 からは起動時コピー） | カーネル RSS <512MB、p95 <100ms/回 |
| K3 | `llm.batch` 20 本、同時 4、gateway 経由 | 429 なし、usage が gateway と DO で一致、部分失敗が返る |
| K4 | セル実行中に DO eviction / Machine Agent kill | セルは unknown、変数喪失が明示、二重書き込み 0 |
| K5 | 悪意ある文書で `llm.query` に秘密を載せる | no-net + hide + 承認で 0 件、拒否が監査に残る |
| K6 | Monty で同じ 10 タスク（テキスト系） | 8/10 以上が動く。動かない 2 つが CPython の必要理由になる |

### 5.3 判断を変える測定

- **K1 の往復が 1 秒を超える** → 同期 HTTP をやめ、非同期 job + callback に切り替える。
- **K2 で RSS が 512MB を超える** → context のチャンク読みを強制し、全文ロードを禁止する。
- **K3 で usage が一致しない** → gateway の usage 解析を先に直す。L2 の予算はここに依存する。
- **K6 で Monty が 8/10 以上** → Monty-first に切り替え、CPython は「データ分析用の任意バックエンド」に下げる。
- **K5 で持ち出しが 1 件でも出る** → L2 を止め、no-net/hide/承認を先に閉じる。

---

## 6. 段階計画

| 段階 | 作るもの | 出口 | 主なリスク |
| --- | --- | --- | --- |
| **P0** | K1〜K3 のスパイク。K1 は 0194 の exec 後。それまでは read/stat の範囲でプロトコルだけ試す | 3 つが 2 週間で動く | 0147/0194 の未完成、gateway 拡張 |
| **P1** | CPython カーネル + `python_repl` + bwrap/no-net + lease | 1 会話で 10 セル、interrupt、復旧が動く | sandbox の穴、プロセス監督 |
| **P2** | context + llm.query/batch + usage/予算 | 10MB ログ + 20 サブコールが予算内 | gateway 課金、DO 再入 |
| **P3** | answer doc + UI プログラムカード + 監査 | 利用者がセル・子・費用・停止を理解できる | answer 読み出し、UI |
| **P4** | 子 RLM + Monty 代替 + snapshot/複数マシン | 深さ 1 の子 RLM、Monty で移行 | 費用、snapshot の版/秘密 |

**P0 の停止条件**: K1（0194 後）が 2 週間で動かない、K3 で usage が一致しない、K5 で持ち出しが 1 件でもある → L2 を保留し、L1 の改善に戻る。

### 6.1 L1 からの移行

- L1 の `codemode` は残す。`deep` のバックエンドを `quickjs` から `cpython` に替えるだけ。
- 会話設定に `agentMode: "chat" | "deep"` と `kernel: "none" | "cpython" | "monty"` を持つ。
- 既定は `chat`。`deep` は利用者が選ぶ。失敗したら `chat` に戻せるが、黙って切り替えない。
- L1 の subagent / budget / events はそのまま使う。L2 は「実行環境」と「サブ LLM」を足す。

---

## 7. リスク・未決

| ID | 未決 | 仮説 | 影響 | 期限/トリガー |
| --- | --- | --- | --- | --- |
| U-01 | CPython か Monty か | CPython 主、Monty 代替 | 全体 | K6 |
| U-02 | カーネルの配置単位 | 会話ごと、2/マシン | リソース | P1 |
| U-03 | セル実行の同期/非同期 | 同期 180s、必要なら job | 信頼性 | K1 |
| U-04 | サブコールの経路 | Worker 内部面 + gateway | 再入・課金 | K3 |
| U-05 | 状態の durable 範囲 | store + ファイル。変数は best-effort | 復旧 | P1 |
| U-06 | snapshot を採るか | Monty のみ。CPython は v1 無し | 複数マシン | P4 |
| U-07 | 子 RLM の深さ/本数 | 1/4、同時 2 | 費用 | P4 |
| U-08 | no-net/hide の配線 | 必須。先に閉じる | 安全 | P1 |
| U-09 | answer の UI 経路 | doc → GraphQL | UX | P3 |
| U-10 | モデル互換 | 2 モデルで開始 | 品質 | P2 |

**前提（これが無いと L2 は出さない）**:

1. 0147 Machine Agent の署名・root 封じ込め・上限が動く。**加えて 0194 の exec/write と、カーネル用の `/kernel/*` op が要る**。
2. bwrap の `--unshare-net` と hide が製品コードに配線される。
3. Worker の `/internal/model/subcall`（device key 認証）と、gateway の stateless completion・usage 解析が入る。
4. answer doc を UI/GraphQL に出す経路がある。
5. 承認または事後監査 + abort のどちらかを決める。

---

## 8. 出典

### hns（一次）
- [docs/durability.md](../../docs/durability.md)、[docs/safety.md](../../docs/safety.md)、[docs/topology.md](../../docs/topology.md)、[docs/limits.md](../../docs/limits.md)、[docs/observability.md](../../docs/observability.md)
- [packages/workspace/src/sandbox.ts](../../packages/workspace/src/sandbox.ts)（bwrap 引数）
- [packages/server/src/do/session.ts](../../packages/server/src/do/session.ts)、[packages/server/src/do/session-rpc.ts](../../packages/server/src/do/session-rpc.ts)
- [packages/server/src/gateway/handler.ts](../../packages/server/src/gateway/handler.ts)、[budget.ts](../../packages/server/src/gateway/budget.ts)
- [work/issues/0147-machine-agent.md](../issues/0147-machine-agent.md)、[0157](../issues/0157-versioned-write-remote.md)、[0159](../issues/0159-live-ws.md)
- [work/research/rlm-harness-feasibility.md](rlm-harness-feasibility.md)

### pi-durable 1.5.0（一次）
- `node_modules/@earendil-works/pi-durable/README.md`（Code Mode、Subagents、Child Tasks、Usage）
- `dist/codemode/codemode.d.ts`（journal、store、nested calls、10,000 tokens）
- `dist/types.d.ts`（TaskRuntime、defineTask、documents）
- `node_modules/@earendil-works/pi-codemode`（QuickJS/WASM、limits）

### prime-agent（一次、`work/scratch/prime-agent` HEAD `fdc0761`）
- `prime-agent-runtime/src/rlm/repl.md`（JSONL v3、fd 分離、done、snapshot/restore、上限）
- `crates/pa-core/src/kernel/{manager,shared.rs}`（ready 30s、65,536 文字、256MiB/16MiB、孤児）
- `crates/pa-core/src/tools/ipython.rs`（timeout 1〜180s）

### 外部（一次・二次）
- RLM 原論文: https://arxiv.org/abs/2512.24601（v3）
- Prime blog: https://www.primeintellect.ai/blog/rlm
- Monty: https://github.com/pydantic/monty 、https://pydantic.dev/docs/monty/ （limitations / security / snapshots）
- Jupyter messaging: https://jupyter-client.readthedocs.io/en/latest/messaging.html
- Jupyter Kernel Gateway: https://jupyter-kernel-gateway.readthedocs.io/
- Cloudflare Sandboxes: https://developers.cloudflare.com/sandbox/
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- E2B persistence: https://docs.e2b.dev/sandbox/persistence
- Daytona snapshots: https://www.daytona.io/docs/en/snapshots/
- Node vm: https://nodejs.org/api/vm.html
- isolated-vm: https://github.com/laverdet/isolated-vm
- gVisor performance: https://gvisor.dev/docs/architecture_guide/performance/
- Firecracker: https://github.com/firecracker-microvm/firecracker

### 注記
- CPython/Jupyter の起動値は本機（NixOS、CPython 3.14、Node 24.22.2、bwrap 0.13.1）の実測。hns の Node 26 で再測する。
- Monty の値は Node 24.22.2 / @pydantic/monty 1.6.0 の実測。Windows/macOS の binary は未検証。
- E2B/Daytona/Modal の起動・snapshot はベンダ主張が中心で、独立追試は未確認。
- DO 再入、180 秒セルの CF/cloudflared 実測、gateway の usage 解析は未検証。P0 で確かめる。




