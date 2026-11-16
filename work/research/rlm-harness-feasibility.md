# RLM ハーネス実現可能性調査

2026-11-17 / 調査（設計判断の材料） / 対象: [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)（HEAD `fdc0761`）と [Recursive Language Models](https://arxiv.org/abs/2512.24601)（v3）

hns に「本物の RLM ハーネス」を組み込めるかを、要素に分解して **採用 / 不採用 / 要検証** に分類する。
結論は「RLM の機構は採用できるが、prime-agent の実装形態（Python 常駐カーネル・自己改善・sandbox なし）は採らない。
hns は pi-durable 1.5.0 の code mode と subagent で **L1（RLM 適応版）** を作り、L2（忠実な REPL）は需要が証明されるまで作らない」。
本調査は実装の可否ではなく、**どの要素をどの順で検証するか** を決めるためのものである。

> **注**: L0〜L3 は本調査の分析ラベルであり、製品の名前ではない。実装では段階名を使わず、`code mode` / `AgentProfile` と呼ぶ。
L2 の実装方式（CPython / Monty、カーネル配置、サブ LLM、状態）は続編の [rlm-l2-implementation-options.md](rlm-l2-implementation-options.md) で比較している。

---

## 0. 結論

### 0.1 判定サマリ

| 判定 | 数 | 中身 |
| --- | --- | --- |
| **採用** | 22 | コード探索・PTC・出力上限・subagent・予算・イベント・権限・監査など。内訳は §3 の表 |
| **不採用** | 10 | Python 常駐カーネル / daemon、dill、pip/venv、A2A、background subagent、memories、goals/heartbeat、自律モード、実行可能スキル、refine。内訳は §5 |
| **要検証** | 10 | 添付、`llm_query`/`llm_batch`、answer 変数、並列 spawn、CF 配備、復旧、注入耐性、モデル互換、複数マシン、環境別 tips。内訳は §6 |

### 0.2 推奨する形（L1: RLM 適応版）

1. **モデルに公開する道具を「コード実行 1 個」に寄せる**（pi-durable の `codemode` と、その subagent パターン）。ファイル・bash・subagent はコード内の関数として呼ぶ。
2. **入力コンテキストは窓の外に置く**。まずはワークスペースのファイル。大きい添付は R2 / DO に置き、モデルにはメタデータ（名前・型・長さ・先頭）だけを渡す。
3. **コードで探索し、要約だけを窓に戻す**。`codemode` の出力上限（既定 10,000 tokens）と、全文のファイル退避を使う。
4. **子エージェントは「セッション」として spawn する**。結果は最終テキストで返し、深さ・本数・トークン・時間を実行ツリー単位で制限する。
5. **既定にはしない**。会話ごとの opt-in モード（`deep`）として出し、既存の file-offload ベースラインと比較してから既定化を判断する。

### 0.2.1 忠実度の段階（「本物」の定義）

「本物の RLM」は一つの点ではなく段階である。hns がどの段階を目指すかを先に決めないと、実装の議論がすれ違う。

| 段階 | 定義 | hns での対応 | 本調査の扱い |
| --- | --- | --- | --- |
| **L0** | context offloading。入力はファイルに置き、モデルは read / bash で必要な部分だけ見る。コードは都度のコマンドで、永続 REPL は無い | 既存の `read_file` + `bash` | **ベースライン**（S0） |
| **L1** | code-first。モデルにはコード実行 1 ツール。ツールはコード内の関数。子エージェントを同期で呼ぶ。状態は JSON store とファイル | `codemode` + `subagent` + `store` | **推奨**（S2） |
| **L2** | 忠実な RLM。永続 REPL 名前空間、prompt-as-variable、`llm_query`/`llm_batch`、answer 変数、sandbox、深さ制御 | Python カーネルまたは永続 JS カーネル + 専用 primitive | **需要が証明されたら**（S3） |
| **L3** | RLM で訓練されたモデル（RLM-Qwen3-8B 等） | プロバイダ依存。hns では選べない | **対象外** |

本調査の推奨は **L1** である。L1 は「本物の RLM」と同一ではない。L1 で足りないのは、永続する変数名前空間、`context` 変数の直接注入、安価な `llm_batch`、answer の反復編集である。
これらが必要かは V1 / V6 で決める。L2 を作る場合も、prime-agent のように「Python 常駐 + dill」ではなく、hns の sandbox と DO に合う形（永続 JS カーネルをマシンで動かす等）を別途設計する。

### 0.3 最初にやるべきこと（順序）

- **S0（新規ランタイムなし）**: まずローカルの `openAgent` で、現行の `bash` を「ワンショットの解析スクリプト」として使うプロンプトと出力上限を整え、**file-offload ベースライン**を測る。RLM 論文の Table 1 では、ファイルオフロード型のコーディングエージェントが CodeQA / BrowseComp+ で RLM と同等だった。hns の既存 `read_file` + `bash` はすでにこの形に近い。
- **S1**: `subagent` ツールと実行予算、イベントを足す。コード実行なしでも「分割・並列・収束」の価値は測れる。
- **S2**: `codemode` を opt-in で足し、S0/S1 と比較する。ここで初めて「本物の RLM 的」になる。
- **S3 以降**: 添付・`llm_batch`・Python カーネルは、S2 の結果が必要性を示したときだけ。

**重要な依存**: Cloudflare の Session DO はまだツールを持っていない（`packages/server/src/do/session.ts` の `createRegistry()` が空。0146 の non-goal）。RLM の code mode は 0147（machine agent）と 0157（remote write）の上に載せる。**別の実行系を並行して作らない**。

---

## 1. 問いと判断基準

### 1.1 解きたい課題

hns の利用者（複数マシンを持つ個人開発者）が困るのは、次のような場面である。

- リポジトリ横断の調査（「この設定はどこで使われているか」「この失敗はどの変更で入ったか」）。
- 長いログ・テスト出力・ビルド出力の解釈（数十万文字をそのまま会話に入れたくない）。
- 複数ファイルにまたがる変更の分割と並列化。
- 長時間の作業で、途中経過を捨てずに再開する。

RLM が解くのは主に **入力がモデルの窓より大きい** 場合の品質とコストである。hns の課題は「入力が大きい」よりも「作業が長い・並列・再開」に寄っている。したがって、RLM の全要素ではなく、
**コンテキストを外に置く / コードで探索する / 子に分割する / 予算で閉じる** の4点が hns に効く可能性が高い。

### 1.2 判断基準

| # | 基準 | 落ちる条件 |
| --- | --- | --- |
| J1 | hns の実タスクで、既存の file-offload + bash より品質が上がる | 同等以下、またはモデル依存で再現しない |
| J2 | 耐久・監査・安全の不変条件を破らない | ack の意味が変わる、秘密が execution に入る、fail closed が崩れる |
| J3 | Cloudflare + マシンの既存構成に載る | 新しい常駐ランタイム・別の正本・別の認証系が要る |
| J4 | 費用と遅延が許容範囲 | p95 が既存の 2 倍超、子の費用が読めない |
| J5 | 失敗したときに戻せる | 既定化してから戻せない、データ移行が要る |

### 1.3 何が分かれば判断が変わるか

- S0 のベースライン測定で、長文ログ・リポジトリ調査の成功率が既に高い → code mode の優先度は下がる。
- S2 で、実モデル（Ollama / OpenCode）がコードを安定して書けない → code mode は「強いモデル専用の opt-in」に限定する。
- 添付需要（PDF・大規模ログ）が利用者にある → `prompt-as-variable` と R2 保存を先に作る。
- 子エージェントの費用が親の 3 倍を超える → subagent は「調査」に限定し、実装作業は単一エージェントに戻す。
- Cloudflare の sandbox Worker の運用が重い → inline か、マシン側の `bash` で代替する。

---

## 2. 事実: RLM と prime-agent は何を実装しているか

### 2.1 原論文（arXiv:2512.24601v3）

**定義**: 長いプロンプト `P` をモデルの窓に入れず、外部環境（REPL）に置く。モデルはコードで `P` を検査・分解し、
必要なら自分自身をスニペットに対して再帰的に呼ぶ。出力は `answer` 変数に育て、`ready` で終了する。

**証拠**（一次確認）:

- 4 タスク（CodeQA 23K–4.2M tokens、BrowseComp+ 6–11M、OOLONG 131K、OOLONG-Pairs 32K）、GPT-5 根 + GPT-5-mini 子、深さ 0–3。
- GPT-5 の中央値で、compaction 比 +26%、CodeAct + サブコール比 +130%、Claude Code 比 +13%。**モデル横断の比較**であり、同条件ではない。
- RLM-Qwen3-8B は Qwen3-8B 比 +28.3%（1,000 サンプルの蒸留）。
- v3 の HTML 要旨は「more than an order of magnitude beyond model context windows」。arXiv の abs ページは「up to two orders」のままで、**表記が揺れている**（版差）。「2桁」を前提にした設計判断はしない。

**限界**（論文 §7 と付録、Prime の追試）:

- 全サブコールが同期・逐次だと遅い。p95 の裾が重い。
- コーディング能力の低いモデルでは機能しない。モデルごとにプロンプト調整が要る。
- 単純な検索（S-NIAH）では RLM が劣化するという独立追試がある。OOLONG でも「分類 + 決定的集約」の素朴なベースライン（62.0）が RLM（56.5）を上回ったという小規模追試がある（△二次情報）。
- ベンチの一部は入力長・タスク依存で、hns の実務（コード編集・運用）への外挿は未検証。

**含意**: RLM は「長文の集約・分解」に強いが、**万能の上位互換ではない**。hns では「コードで探索する」と「子に分割する」を部品として採り、RLM 全体を既定のループにはしない。

### 2.2 prime-agent の実装（HEAD `fdc0761`）

prime-agent は README で「Self-Improving RLM Harness」を名乗るが、実装は **Rust ホスト + Python カーネル**の2層で、
モデルに公開されるツールは **`python_repl` 1 個だけ**である。hns の移植先として重要なのは、この「単一ツール + プログラム的呼び出し + 永続状態」の形である。

| 層 | 実体 | 根拠 |
| --- | --- | --- |
| モデル境界 | `python_repl`（`code`, `timeout`）のみ | `crates/pa-core/src/tools/ipython.rs` |
| 実行層 | セッションごとに常駐 CPython（`-P -s -m rlm.repl`）、1 名前空間 + 1 asyncio ループ | `kernel/manager/startup.rs`, `prime-agent-runtime/src/rlm/repl.md` |
| 制御層 | daemon（supervisor）→ session worker → kernel | `crates/pa-daemon/src/supervisor.rs` |
| 永続層 | 追記 JSONL（セッション）+ dill スナップショット（名前空間）+ JSON（harness） | `session_store.rs`, `state_snapshot.rs` |
| サブエージェント | 別 worker の実セッション。`rlm.spawn` は即返り、結果は `agent_message` で後着 | `rlm_children/host.rs`, `prompts/layers/core.md` |
| セキュリティ | **sandbox なし・承認なし**。README が明示 | `README.md` |

**注目すべき差分（「本物」の解釈）**:

1. **`context` 変数は注入されていない**。README の「prompt-as-a-variable」は、実装では「トランスクリプトを `rlm.session.messages()` で読み、Python の変数に切り出す」に置き換わっている。つまり prime-agent の RLM は、**論文の canonical RLM よりも「ファイル + トランスクリプト + REPL」寄り**である。
2. **子の結果は戻り値ではない**。`rlm.spawn` は即返り、子は親に `agent_message` を送る。非同期・メッセージ駆動で、同期の `llm_query` とは別物。
3. **名前空間は dill で丸ごと保存**する（変数あたり 16 MiB、全体 256 MiB、1.5 秒デバウンス）。復元は名前単位で失敗を許す。
4. **プロンプトは層構造**（不変の core / usage / opinionated + 動的 tail + `[harness-digest]`）。refine はベースプロンプトを書き換えない。
5. **Continual Harness** は `harness_state.json` の entry（memory / prompt note / skill / subagent spec）を、レビューゲート・監査行・ロールバック付きで更新する。自動 refine は compaction 起点・20 分クールダウン。

**hns にとっての含意**: 採用すべきは「単一ツール + PTC + 永続状態 + 層プロンプト + 監査付き更新」の**型**であり、
Python カーネル・dill・daemon・sandbox なし実行は hns の制約と衝突する。

### 2.3 他の実装・研究との位置関係

RLM の独自性は「入力を窓の外に置く」「コードで操作する」「再帰する」の**組み合わせ**にある。個々の部品は既存の製品・研究に散在している。

| 実装 / 研究 | 共通点 | RLM との差分 | hns への示唆 |
| --- | --- | --- | --- |
| [alexzhang13/rlm](https://github.com/alexzhang13/rlm)（参照実装） | prompt-as-variable、`llm_query`/`rlm_query`、answer dict、深さ別ルーティング | LocalREPL は同一プロセス `exec()`。Docker / Modal で隔離するが、既定は production 非推奨 | canonical な形。**そのままは採らない**（E-04 / E-05） |
| [DSPy RLM](https://dspy.ai/current/api/modules/RLM/) | 同じ signature（`context, query -> answer`）、`SUBMIT`、`max_iters` / `max_llm_calls` | サンドボックスは Deno + Pyodide の WASM。ホストツールは sandbox の外 | 「WASM sandbox + 反復上限」は hns の QuickJS 方針と近い |
| verifiers `RLMEnv`（Prime Intellect） | 並列 `llm_batch`、サブ LLM へのツール付与、answer 変数 | 再帰深さは現状 1 固定 | `llm_batch` と「ツールは子だけ」の設計（E-11 / E-32） |
| [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) | 単一 REPL ツール、programmatic tools、子セッション、harness | 子は非同期メッセージ。sandbox なし。Python 常駐 | 単一ツール + 永続状態 + 層プロンプトの型（E-01 / E-27） |
| OpenHands CodeAct / smolagents CodeAgent | コードを行動空間にする | **入力はプロンプト内**。prompt-as-variable が無い | コード行動だけでは窓の制約を超えられない |
| Claude Code / OpenAI Code Interpreter / LangChain deepagents | ファイルオフロード、subagent、compaction | サブ呼び出しをコードのループで回せない。入力はメッセージ | **hns の L0 に最も近い**。RLM と同等のスコアを出す場合がある（V1） |
| [Context-Folding](https://arxiv.org/abs/2510.11967) / [AgentFold](https://arxiv.org/abs/2510.24699) | 能動的な文脈管理（分岐・折り畳み） | サブ軌跡を要約して畳む。RLM は変数に残す | RLM の代替・併用。E-13 の参考 |
| [ACE](https://arxiv.org/abs/2510.04618)（Agentic Context Engineering） | 文脈を playbook として更新 | Generator / Reflector / Curator の3役。RLM とは直交 | E-30 を将来やるならこの系譜 |
| [MemGPT](https://arxiv.org/abs/2310.08560) | OS 的なメモリ階層 | 割込みで仮想文脈を管理。コードで能動操作はしない | E-24 を将来やるなら参考 |
| Context Rot / Lost in the Middle | 長文で品質が落ちる | RLM の動機。ただし retrieval / folding でも回避できる | 「長い＝RLM」と短絡しない |

**注記**: この表はブログ・README・追試などの二次情報を多く含む。実装の細部（サンドボックスの方式、再帰の深さ、料金）は各リポジトリで再確認する。

**読み方**: CodeAct は「コードで行動する」が、入力は窓に置く。file-offload 型は「入力を外に置く」が、サブ呼び出しをコードで制御しない。RLM は両方を満たすが、その優位は**情報密度の高い集約タスク**（OOLONG-Pairs など）で特に大きい。
hns の coding タスクでは L0 と L1 の差が小さい可能性があり、V1 で確かめる。

### 2.4 hns の現状

| 項目 | 現状 | 根拠 |
| --- | --- | --- |
| ランタイム | pi-durable **1.5.0 固定**。`codemode` / `createCodemodeExtension` と、その依存の `@earendil-works/pi-codemode`（`RemoteCodemodeSandbox`）が使える | `packages/agent/package.json`, `node_modules/@earendil-works/pi-durable`, `node_modules/@earendil-works/pi-codemode` |
| code mode | **未使用**。モデルには `read_file` / `write_file` / `bash` を直接公開（ローカル `openAgent`） | `packages/agent/src/agent.ts`, `tools.ts` |
| Cloudflare Session | `openSession` に空の registry。ツール未配線。0146 の non-goal | `packages/server/src/do/session.ts` |
| ツール実行 | machine agent（0147）と remote write（0157）が前提。まだ完成していない | `work/BOARD.md`, `docs/durability.md` |
| ファイル | 版付き読み書き、`.git` 保護、root 封じ込め、bwrap、秘密の hide、fail closed | `docs/workspace.md`, `docs/safety.md` |
| 会話 | 複数会話、transcript、abort、compaction は pi-durable。添付・大きい入力の保存は無い | `packages/agent/src/session.ts`, `packages/core/src/types.ts` |
| 制限 | 会話ごとのレート、日次トークン、ターン時間。**実行ツリーの予算は無い** | `docs/limits.md` |
| 観測 | ツール名・所要・成否のみ。引数・出力は残さない | `docs/observability.md` |
| 配備 | 本体 Worker + gateway Worker（service binding）。別 Worker の DO を束ねる形は既にある | `tools/deploy/cloudflare.config.ts` |

**決定的な制約**: Cloudflare 側の会話はまだ「テキストのみ」で、ツール実行は 0147 / 0157 の仕事である。
したがって RLM の code mode を Cloudflare に載せるには、**machine の ExecutionEnv を pi-durable のツールに接続する**作業が先に要る。
本調査の S0/S1 は、まず `packages/agent`（Node）の `openAgent` で検証し、CF への移植は同じ抽象（`ExecutionEnv` + Workspace）に乗せる。

---

## 3. 要素の分解と分類

判定の読み方: **採用** = hns の設計に取り入れる。**不採用** = 今は作らない（理由を残す）。**要検証** = 先に実験しないと決めない。
「条件」は採用時の限定条件。根拠の強さは ✅ 一次（論文本文・コード）、△ 二次（追試・ブログ・表の抽出）、? 未確認で示し、△ は要検証に寄せている。

| ID | 要素 | 解く問題 | 参照 | hns の現状 | 判定 |
| --- | --- | --- | --- | --- | --- |
| E-01 | 単一ツール + コード実行（永続 REPL は L2） | モデルの行動空間をコードに統一し、ツール定義の爆発を避ける | prime-agent `python_repl` 1 個 | ツールを直接公開 | **採用**（`codemode` を opt-in） |
| E-02 | Programmatic tool calling | ツール呼び出しをコードの制御構造（ループ・並列・条件）に入れる。中間結果を窓に戻さない | `tools.read(...)` 等 | 1 呼び出し 1 ツール | **採用** |
| E-03 | 出力上限 + 全文のファイル退避 | ツール出力で窓を埋めない | codemode の `max_output_tokens`、bash の tail | read 32K 文字、bash は tail | **採用** |
| E-04 | コード実行の分離 | 任意コードを安全に走らせる | QuickJS / bwrap | bwrap は exec のみ | **採用**（QuickJS + ツール allowlist） |
| E-05 | 名前空間スナップショット | 変数を再起動後も保つ | dill（16 MiB/変数） | 無い | **不採用**（pickle・サイズ・監査性） |
| E-06 | 常駐カーネル / daemon | プロセスを跨いで REPL を維持 | supervisor + worker + kernel | DO + machine | **不採用**（二重の実行系） |
| E-07 | pip / venv の可変化 | データ分析ライブラリを自由に使う | kernel venv | 無い | **不採用**（再現性・供給網） |
| E-08 | prompt-as-variable | 長い入力を窓の外に置く | 論文の `P`、prime-agent は transcript 読み | 会話に全文が入る | **採用**（まずファイル、次に添付） |
| E-09 | 大容量入力の保存・参照 | PDF・ログ・データセットを扱う | 論文の外部環境 | 添付モデルが無い | **要検証** |
| E-10 | コードによる探索（grep/chunk/map） | 全文を読まずに必要な部分だけ見る | 論文 §2 | bash で可能 | **採用** |
| E-11 | `llm_query` / `llm_batch` | 安価なサブ呼び出しをコードから並列に出す | 論文、verifiers、DSPy | 無い | **要検証** |
| E-12 | answer 変数 / ready | 出力を育ててから確定する | 論文、Prime の `answer` | 最終メッセージ | **要検証** |
| E-13 | compaction との併用 | 長い会話を畳んでも作業状態を失わない | prime-agent は REPL 状態を維持 | pi-durable compaction | **採用**（既存 + 状態の分離） |
| E-14 | コンテキスト会計 | 主モデルと子のトークンを分けて見る | prime-agent の usage 発生源別 | usage は会話単位 | **採用** |
| E-15 | 子エージェント spawn | 調査・実装を分割する | `rlm.spawn` / pi-durable subagent | 無い | **採用**（同期・深さ 1 から） |
| E-16 | 並列 spawn / batch | 独立した子を同時に走らせる | `llm_batch`、spawn 即返り | 無い | **要検証** |
| E-17 | 深さ・本数・兄弟の上限 | 再帰の爆発を防ぐ | prime-agent 既定深さ 2 | 無い | **採用** |
| E-18 | 子の監視・収集 | 進捗と結果を UI / 親が把握する | `list_subagents` / `collect` | 無い | **採用** |
| E-19 | A2A メッセージ / 放送 | 兄弟・親子が直接やり取りする | `agent_message` | 無い | **不採用**（初期） |
| E-20 | background / retained subagent | 親のターンを跨いで子を残す | retained subagent | 無い | **不採用**（初期。S3 で再検証） |
| E-21 | モデル / thinking の継承・選択 | 子を安価なモデルにする | `spawn(model=...)` | 会話ごとのモデル | **採用** |
| E-22 | セッションログ / 分岐 | 監査・再開・fork | JSONL + parent_id | pi-durable entries / fork | **採用**（fork UI は出さない） |
| E-23 | クラッシュ復旧 | 途中で落ちても続きから | dill + journal | code mode の journal | **要検証** |
| E-24 | 長期記憶（memories） | セッションを跨ぐ知識 | harness state | AGENTS.md / workspace | **不採用**（初期） |
| E-25 | goals / heartbeat / schedules | 長期の自律実行 | `goal.*`, `rlm_heartbeat` | Task / Automation / Workflow | **不採用**（重複） |
| E-26 | 自律モードの予算 | ターン・トークン・時間で止める | autonomous | ターン時間のみ | **不採用**（製品はユーザー駆動） |
| E-27 | プロンプトの層構造 | キャッシュ安定 + 動的 tail | core/usage/opinionated | pi-durable sections | **採用** |
| E-28 | 環境別 tips | タスク別の戦略を与える | `_ENV_TIPS` | 無い | **要検証**（A/B） |
| E-29 | 実行可能スキル | 再利用可能な Python 関数 | skills | AGENTS.md / bash | **不採用**（供給網・権限） |
| E-30 | Continual Harness / refine | プロンプト・記憶を自動改善 | `refine.run` | 無い | **不採用**（監査・注入） |
| E-31 | プロジェクト文脈 | リポジトリの指示を読む | AGENTS.md | 既存 | **採用** |
| E-32 | ツール権限（親 / 子） | 危険な道具を子だけに許す等 | ツールは子のみ（Prime blog） | 全ツール同一 | **採用** |
| E-33 | 承認・監査 | 危険操作を止めて残す | prime-agent は無し | 監査イベントのみ | **採用** |
| E-34 | 注入・持ち出し耐性 | リポジトリ内の指示で秘密を送らせない | sandbox | bwrap + 秘密 hide | **要検証** |
| E-35 | 進捗表示（コード / 子） | 何をしているか見える | TUI の subagent パネル | ツール名のみ | **採用** |
| E-36 | 介入（停止・steer・承認） | 暴走を止める | abort / interrupt | abort のみ | **採用** |
| E-37 | 実行ツリー予算 | 子を含めた上限 | goal budget / autonomous | 会話単位 | **採用** |
| E-38 | 観測（trace / usage） | 再現・費用分析 | usage、traces | イベント | **採用** |
| E-39 | 配備（sandbox Worker） | code mode を CF に載せる | RemoteCodemodeSandbox | 未配備 | **要検証** |
| E-40 | 複数マシン | どのマシンでコードを走らせるか | daemon はローカル | machine agent 未完成 | **要検証** |
| E-41 | モデル互換 | 弱いモデルでも動くか | モデル別チューニング | 2 provider | **要検証** |
| E-42 | 評価タスクセット | 効果を再現可能に測る | verifiers / eval | 無い | **採用** |

---

## 4. 採用する要素（設計）

### 4.1 E-01 / E-02 / E-03: code-first モード

**形**: pi-durable の `createCodemodeExtension` を `@hns/agent` に入れ、会話ごとに `agentMode: "chat" | "deep"` を持つ。
`deep` では `modelTools` を `[codemode]` に絞り、`read_file` / `write_file` / `bash` / `subagent` はスクリプトから `tools.*` で呼ぶ。
`chat` は現行のまま。

**なぜ**: prime-agent の「モデルに見せるツールは 1 個」は、ツール定義のトークンと選択ミスを減らす。pi-durable の code mode は
入れ子の呼び出しを `pi.live.nestedTools` に出し、結果を journal に書く。ツール呼び出しの並列化・条件分岐・出力の絞り込みがコードで書ける。

**実装上の注意**:

- `workspaceTools` の `read_file` / `write_file` に `structuredOutputSchema` を付ける。code mode のスクリプトは構造化結果を扱える方が書きやすい（現状は text のみ）。
- `write_file` の `expectedVersion` はコード内で read → write の順に取る。競合は値で返るので、スクリプトが再読込できる。
- code mode の出力上限は既定（10,000 tokens）から始め、`max_output_tokens` を会話設定で変えられるようにする。全文は `fullOutputPath` に退避される。
- `bash` は sandbox があるときだけ登録する（現行の fail closed を維持）。code mode の script から `tools.bash` が見えない場合は、その旨をプロンプトに出す。
- `@earendil-works/pi-codemode` は pi-durable の推移依存として既に入っているが、直接 import するなら `packages/agent/package.json` に **1.5.0 で宣言**し、依存理由を decision に残す（AGENTS.md の依存規則）。

**失敗モード**: モデルが JS を書けない → `chat` に戻せる。スクリプトが長大 → 出力上限とタイムアウトで切る。ツールの誤用 → 既存の型検証と Workspace の版チェックで拒否する。

### 4.2 E-15 / E-17 / E-18 / E-21: subagent

**形**: `subagent({ task, model?, name? })` ツール。pi-durable の subagent 例に従い、`ownership: { kind: "task", taskId }` の子会話を作る。
子は親の agent（モデル・拡張・cwd）を継承し、深さが上限なら `subagent` 拡張を外す。結果は子の最終アシスタントテキストを返す。

**制限**:

- 深さ: 既定 1（親 → 子）。設定で最大 3。prime-agent の既定 2 を参考にしつつ、hns はまず 1。
- 本数: 1 実行あたり 4。同時 2。
- 子のモデル: 既定は親と同じ。安価なモデルを指定できるようにする（E-21）。
- 子のツール: 親と同じ。ただし `subagent` は深さで外す。危険なツール（network / bash）は設定で外せる（E-32）。

**なぜ同期か**: prime-agent は非同期メッセージだが、hns の会話 UX は「送ったら返る」が基本で、子の結果を親の次のターンに持ち込む仕組みがまだ無い。
まず同期で「待つ・返る」を作り、必要なら E-20（background）を検証する。

**保存**: 子の会話 ID をツール結果の `details` に入れ、UI が子へ遷移できるようにする。usage は子の会話に付き、親の実行ツリー集計に合算する（E-14）。

### 4.3 E-08 / E-10 / E-13 / E-27 / E-31: コンテキストとプロンプト

**形**:

- `deep` 用の section を 1 つ追加する。内容は「コンテキストはワークスペースのファイルにある。全文を読む前に、コードで検索・分割・要約せよ。出力は必要な分だけ。子に任せられる作業は子に渡せ」。
- 既存の `AGENTS.md` / プロジェクト文脈はそのまま読む（E-31）。
- compaction は pi-durable に任せる。code mode の `store` は会話に紐づき、compaction では消えない（E-13）。ただし変数の代替は JSON のみ（E-05 不採用）。
- 大きい入力は、まずワークスペースのファイルとして置く。会話に全文を貼らない導線を UI に作る（E-09 は要検証）。

**なぜ**: 原論文の本質は「入力を窓に入れない」こと。prime-agent も実際には `rlm.session.messages()` でトランスクリプトを読ませており、専用の `context` 変数は無い。hns はワークスペースという自然な外部環境を既に持っている。

### 4.4 E-14 / E-37: 実行予算

**形**: `RunBudget` を会話の document（または実行タスクの input）に持つ。

| 項目 | 既定 | 超えたとき |
| --- | --- | --- |
| 深さ | 1 | `subagent` を拒否 |
| 子の本数 / 同時 | 4 / 2 | 拒否またはキュー |
| サブ呼び出し回数 | 16 | 拒否 |
| 実行ツリーのトークン | 会話の日次予算の範囲内 | 次のリクエストを止める |
| 実行ツリーの時間 | 10 分 | abort |

**なぜ**: prime-agent は goal / autonomous の予算を持つが、hns の既存 `limits` は会話単位で、子を含めた合計を見ていない。
RLM の費用は子に集中するので、**木全体**で閉じる必要がある。gateway の usage と接続する（E-38）。

### 4.5 E-04 / E-32 / E-33 / E-34: 安全

**形**:

- code mode の VM は QuickJS（pi-codemode）。ファイル・ネットワーク・環境変数は直接触れず、**ツールだけ**が能力。ツールは会話の registry で絞る。
- `bash` は bwrap があるときだけ。秘密ディレクトリは hide。ネットワークは現状残るため、**外部への持ち出しは別途制限**する（E-34）。
- `subagent` は親の権限を継承する。子にだけ許す・子から外すを設定で選べる（E-32）。
- 監査: `code.call` / `code.result` / `subagent.spawn` / `subagent.settle` をイベントに追加。引数・出力の本文は残さず、長さ・ハッシュ・成否・所要だけにする（既存の方針）。
- 危険操作（`bash` の network、`write_file` の大量書き込み）は承認を挟めるようにする（E-36）。初期は「事後監査 + abort」でもよいが、fail closed の原則から**承認なしで network を許さない**選択肢を残す。

**なぜ**: prime-agent は sandbox なし・承認なしで、hns の `docs/safety.md` と正面から衝突する。ここは**採らない**。QuickJS の capability 制限は、Python `exec` より hns に合う。

### 4.6 E-35 / E-36 / E-38: 観測と UX

**形**:

- 会話画面に「プログラム」カードを出す。コード、出力（切った分は全文へのリンク）、入れ子のツール呼び出し、子の一覧（状態・所要・トークン）を表示する。
- 実行中は `stop`、子の `abort`、必要なら `steer`（次のターンにメッセージ）を出す。
- イベントは既存の `AgentEvent` を拡張し、GraphQL / WS（0159）に載せる。引数や本文は残さない。
- usage は「主 / 子 / ツール」に分けて集計する。prime-agent の発生源別（spawn / message / direct）を参考にする。
- `deep` の入口は会話設定のトグルと「リポジトリ全体を調べる」テンプレートに限定し、**自動では切り替えない**（モデル・費用・監査の意味が変わる）。失敗時は同じ会話で `chat` に戻せるが、黙ってフォールバックしない。
- コードと出力は会話本文に混ぜず、折りたたみカードにする。ストリーミングは本文とは別チャネル（0159 の WS）に載せる。

---

## 5. 採用しない要素（理由）

| ID | 要素 | 採らない理由 | 代わりに |
| --- | --- | --- | --- |
| E-05 | dill 名前空間スナップショット | 任意オブジェクトの pickle は Workers で動かず、復元は信頼できないデータのデシリアライズになる。サイズも読めない | code mode の `store`/`load`（JSON、上限付き）、ワークスペースのファイル |
| E-06 | 常駐カーネル / daemon | hns は DO が耐久と再開を持ち、machine は exec を持つ。3 つ目のプロセス監督を足すと、正本と障害モデルが増える | DO + pi-durable + 0147 の machine agent |
| E-07 | pip / venv の可変化 | 再現性・供給網・イメージサイズ。モデルの提案で依存が増えると監査できない | リポジトリのツール（`uv` / `npm`）を `bash` で明示実行 |
| E-19 | A2A メッセージ | 家族モデルは強力だが、宛先・順序・再送・監査の面が増える。まずは戻り値で足りる | 同期 subagent、必要なら親への通知 |
| E-20 | background retained subagent | 親のターンを跨ぐ子は、abort・課金・再開の意味を決め直す必要がある | まず同期。S3 で再検討 |
| E-24 | memories | 自動記憶は注入の永続化・監査・削除の責任が重い。hns は AGENTS.md とワークスペースで足りる | プロジェクト文書、会話ログ |
| E-25 | goals / heartbeat / schedules | Task / Automation / Workflow と重複する。二つ目のスケジューラを作らない | 既存の Automation（0018） |
| E-26 | 自律モード | hns はユーザーが開始・停止する製品。無人の継続は別プロダクトの性格 | 実行予算と再開 |
| E-29 | 実行可能スキル | Python モジュールの自動 import は供給網と権限の境界を壊す | Markdown の指示書、登録済みツール |
| E-30 | Continual Harness / refine | harness state（prompt note / memory / skill）の自動更新は、注入の永続化・品質劣化・説明責任を招く。prime-agent もレビューゲートとロールバックを置いているが、hns にはその運用が無い | 手動・版管理された playbook（将来） |
| — | RLM を既定のループにする | 論文・追試ともタスク依存。hns の coding タスクでは file-offload と同等の可能性が高い | opt-in の `deep` モード |

**補足**: E-06 を採らないのは「Python が不要」という意味ではない。データ分析が必要なときは `tools.bash` で
`python3 script.py` を**都度**実行し、入出力をファイルにする。状態はワークスペースに置く。これで「永続カーネル」の大半の用途は代替できる（速度と変数の利便性は落ちる）。

---

## 6. 要検証（実験計画）

各実験は「何が分かれば判断が変わるか」を先に決め、成功条件を満たさなければ**作らない**。

| ID | 検証 | 方法 | 成功条件 | 判断 |
| --- | --- | --- | --- | --- |
| V1 | code mode の品質 | S0（file-offload + bash）と S2（code mode）を、同じ 10 タスク（§6.2）× 3 回で比較。モデルは Ollama / OpenCode の実モデル | 10 中 7 以上で同等以上、うち 3 以上で明確な改善。失敗率が悪化しない | 悪ければ opt-in のまま／中止 |
| V2 | code mode の CF 配備 | `RemoteCodemodeSandbox` を別 Worker で立て、p50/p95、CPU、メモリ、課金、interrupt budget を測る。inline とも比較 | p95 が既存ターン +1 秒以内、失敗率 <1% | 重ければ inline かマシン実行 |
| V3 | subagent の費用対効果 | 深さ 1・本数 1/2/4、子モデル同一/安価で、調査タスクの成功率とトークン | 本数 2 で成功率 +15pt、費用 +50% 以内 | 効果が無ければ既定 off |
| V4 | 復旧 | code mode 実行中に DO を落とし、journal から再開する。ワークスペース書き込みの二重適用が無いこと | 再開後に同じ結果、二重書き込み 0 | 破れれば code mode を保留 |
| V5 | 安全 | リポジトリ内の悪意ある指示で、秘密の読み出し・外部送信・sandbox 脱出を試す。bwrap 有無の両方 | 秘密の持ち出し 0、脱出 0、拒否が監査に残る | 1 件でも破れれば承認必須へ |
| V6 | 大容量入力 | 1MB / 10MB / 100MB のログ・PDF を添付し、保存・参照・トークン・遅延を測る | 100MB で初回表示 p95 < 60 秒、費用 < 既存の 2 倍 | 難しければ「ファイルをワークスペースに置く」導線だけ |
| V7 | モデル互換 | 4 モデル（強/中/弱）で、コード生成・ツール呼び出し・修復の成功率 | 2 モデル以上で実用 | 弱いモデルは chat に固定 |
| V8 | UX | プログラムカードと子の表示で、停止・再開・理解ができるか。5 名程度の内部テスト | 被験者が「何が起きたか」を説明でき、停止できる | 説明できなければ既定にしない |

**要素との対応**: E-09 → V6、E-11 / E-12 → V3 / V6、E-16 → V3、E-23 → V4、E-28 → V1（tips あり / なし）、E-34 → V5、E-39 / E-40 → V2 / V6、E-41 → V7。

### 6.1 実装前の最小スパイク（1〜2 日）

本実装の前に、pi-durable の API が想定どおり動くかを 3 点だけ確かめる。ここで詰まると、S1/S2 の見積もりが崩れる。

| # | スパイク | 成功条件 |
| --- | --- | --- |
| K1 | `packages/agent` の Vitest に `createCodemodeExtension` + `CodemodeSandbox` を入れ、`read_file` を 2 回呼ぶスクリプトを実行 | 入れ子呼び出しが `pi.live.nestedTools` と結果に出る。出力上限が効く |
| K2 | MemoryStorage で `subagent` ツールを 1 個作り、子会話を spawn して最終テキストを受け取る | 子の transcript と usage が取れる。abort で子も止まる |
| K3 | 100KB / 1MB のファイルを読むスクリプトで、出力の切り詰めと `fullOutputPath` を確認 | モデルに返るのは上限まで。全文はファイルに残る |

**判断**: K1〜K3 が 2 日で動かないなら、S2 の前提（pi-durable の API 理解）が不足している。実装を広げず、API の読み込みに戻る。

### 6.2 V1 のタスクセット（案）

「hns の実タスク」を固定しないと、比較がモデルの気分になる。次の 10 種を `work/` の評価セットに置き、各 3 回試行する（計 30 試行）。

| # | タスク | 何を測るか |
| --- | --- | --- |
| T1 | リポジトリ横断で、ある設定キーの参照箇所を全部挙げる | 検索の網羅性・根拠の提示 |
| T2 | 失敗しているテスト 1 本の原因を、ログとコードから特定する | 長いログの扱い・仮説の質 |
| T3 | 2 ファイルの小さな変更を、テストまで通す | 実装の完遂 |
| T4 | 4 ファイルにまたがる変更を、既存の型に合わせて行う | 分割・整合 |
| T5 | 1,000 行の仕様メモから、実装項目を抽出して順序づける | 長文の構造化 |
| T6 | 100KB のビルドログから、最初の原因を 3 つに絞る | 出力の遮蔽・要約 |
| T7 | 1MB のアクセスログから、異常な時間帯を特定する | 大容量入力（L0 の限界） |
| T8 | 依存更新の影響範囲を、`package.json` と import から列挙する | 横断・見落とし |
| T9 | 既存の差分をレビューし、規約違反を指摘する | 判断の質 |
| T10 | ドキュメントと実装の不一致を 3 件見つける | 照合・根拠 |

**測るもの**: 成功率（人手の判定）、主モデルのトークン、子のトークン、ツール呼び出し回数、p50/p95 時間、費用、危険操作の回数。
**判定**: S0 と S2 の差が、T1/T2/T6/T8 で +1 以上（5 段階）なら L1 の価値あり。T3/T4/T9 で差が無いなら、coding は L0 のままでよい。

**特に重要な V1**: RLM 論文の Table 1 では、OpenCode + context offloading が CodeQA 64.0 / BrowseComp+ 94.0 で、RLM の 62.0 / 91.3 と同等だった（△ 表組みからの抽出。PDF で再確認する）。
hns の既存 `read_file` + `bash` はこの「file-offload 型」に近い。**code mode を足す前に、S0 のベースラインを測る**。
ベースラインが強い場合、投資対効果は「コードで探索する」より「子への分割」に寄る。

---

## 7. 統合アーキテクチャの選択肢

| 案 | 内容 | 長所 | 短所 | 判定 |
| --- | --- | --- | --- | --- |
| A | DO の code mode + 別 Worker の RemoteCodemodeSandbox | 既存の pi-durable に乗る。入れ子呼び出し・journal・UI が揃う。DO をブロックしない | Worker が 1 つ増える。DO→DO のホップと課金 | **推奨（S2）** |
| B | DO の inline code mode | 追加配備なし | スクリプトが DO をブロックする。CPU 30 秒制限 | 試作のみ |
| C | マシン常駐の Python/Node カーネル + RPC | Python の資産・変数・速度。実行がマシンに残る | 新しいプロセス監督・認証・復旧・sandbox。0147 の上にさらに積む | S3 以降、需要次第 |
| D | prime-agent を sidecar で動かす | 実績ある実装をそのまま使える（MIT） | Rust/Python の配備、別の状態・認証・UI、hns の durability と二重 | 不採用（研究用の比較のみ） |
| E | コード実行なし。file-offload + プロンプト + subagent のみ | 最小の変更。既存の安全・耐久をそのまま使う | プログラム的呼び出し・永続変数・並列が無い | **S0/S1 のベースライン** |

**推奨**: **E → S1 → A** の順。C は V6 が「Python のデータ処理が必要」と示したときだけ。D は比較対象として言及するが、製品には入れない。

### 7.1 どこに何を置くか

| 構成要素 | 置き場所 | 備考 |
| --- | --- | --- |
| `codemode` 拡張 | `@hns/agent`（`./session` は Worker-safe のまま） | `createCodemodeExtension` と sandbox の注入 |
| sandbox Worker | `tools/deploy` の別 Worker + DO | gateway と同じ service binding の形 |
| subagent | `@hns/agent` のツール + 子会話 | pi-durable の ownership |
| 実行予算 | `@hns/agent` の document + gateway の usage | 木全体の合計 |
| イベント | `@hns/agent` の `AgentEvent` → server → GraphQL/WS | 本文は残さない |
| 添付 | `@hns/store` / R2 + `@hns/core` の型 + UI | S3。まずワークスペース |
| 評価 | `work/` のタスクセット + 実モデル | 製品コードに入れない |

### 7.2 実装規模の目安

粗い見積もり（設計・実装・テスト・配備を含む）。確定見積もりではない。

| 対象 | 規模 | 主な内訳 |
| --- | --- | --- |
| ローカルの code mode（opt-in） | **M**（1〜2 週間） | `createCodemodeExtension`、structured output、ツール絞り込み、テスト |
| リモート sandbox Worker | **M〜L**（2〜4 週間） | 別 Worker / DO、binding、`cf` 配備、制限・課金の実測 |
| 同期 subagent | **M**（1 週間） | ownership、深さ・本数、子の usage、UI の詳細 |
| 実行予算 | **S〜M**（数日〜1 週間） | document、gateway の usage、停止条件 |
| 添付・大容量入力 | **L**（3〜4 週間） | core の型、store / R2、API、UI、上限 |
| `llm_batch` / answer 変数 | **L**（2〜4 週間） | durable な stateless completion、費用会計、終了契約 |
| Python カーネル（L2） | **XL**（1〜2 か月） | machine プロセス、プロトコル、sandbox、復旧、配備 |
| refine（採用しない） | **L** | 状態・監査・ロールバック・レビュー用モデル |

**読み方**: S0 は 0、S1 は M、S2 は M〜L。**S2 までで 1 か月強**が目安。L2 はさらに 1〜2 か月で、運用も増える。
「本物かどうか」より「1 か月で価値が出るか」で切るなら、S1 → S2 の順が妥当である。

---

## 8. 段階計画とゲート

| 段階 | 作るもの | 出口（ゲート） | 主なリスク |
| --- | --- | --- | --- |
| **S0** | 何も作らない。プロンプトと `bash` の使い方、出力上限、file-offload の導線を整える | V1 のベースラインが取れる。10 タスク × 3 回の成功率・トークン・時間が記録されている | ベースラインが強すぎて RLM の出番が無い（それならそれで良い） |
| **S1** | `subagent`、実行予算、イベント、UI の最小 | V3 で費用対効果、V8 で理解可能性。同期・深さ 1 で安全に動く | 子の費用、abort の伝播、UI の複雑化 |
| **S2** | `codemode`（opt-in）、sandbox Worker、プログラムカード | V1 / V2 / V4 / V5。既存ベースラインに勝ち、復旧と安全が破れない | CF の配備・課金、モデルのコード能力 |
| **S3** | 添付・`llm_batch`・answer 変数・Python カーネル（条件付き） | V6 / V7。大容量入力と並列の価値が確認できる | 保存・課金・セキュリティ |
| **S4** | 既定化の判断 | 2 週間の利用で、deep モードの方が良いと説明できる | 既定化の撤回コスト |

**各段階の停止条件**:

- S1: 子の成功率が親単独より低い、または費用が 2 倍超 → 同期 subagent を保留。
- S2: V5 で 1 件でも秘密の持ち出し・脱出 → code mode を保留し、承認必須に戻す。
- S3: V6 で 100MB が実用にならない → 添付を「ワークスペースに置く」に限定。
- S4: 既定化は、deep モードを選んだ会話の方が「やり直しが少ない」と示せたときだけ。

### 8.1 ゲート判定（案）

[docs/process.md](../../docs/process.md) の形式で、今回の調査の出口を置く。

- 段階 / 判定日 / 判断責任者: 基本設計 / 2026-11-17 / user
- 次に進める対象・作業・期間: S0（V1 のベースライン）と S1 の設計。S2 は V1 の後。
- 対象外: L2（Python カーネル）、既定化、添付、refine。
- 判定: **Limited Go**
- 条件・制限: 0147 / 0157 の進捗に合わせる。S1 は同期・深さ 1・本数 4。S2 は opt-in に限定する。
- 未決の責任者と期限: U-01〜U-10 は user。V1 の結果で再判定する。
- 再判定: V1 の 30 試行（10 タスク × 3）が終わった時点。
- 理由: 効果がタスク依存で、既存の L0 が強い可能性がある。**作る前に測る**。

---

## 9. 未決・リスク台帳

| ID | 未決 | 仮説 | 影響 | リスク | 期限 / トリガー |
| --- | --- | --- | --- | --- | --- |
| U-01 | code mode を既定にするか | しない。opt-in | 全会話の挙動 | モデル依存・遅延 | V1 の結果 |
| U-02 | 添付の保存先と上限 | R2 + メタデータだけ DO | 大容量入力 | 費用・実装 | V6 |
| U-03 | `llm_query` を子会話で作るか、直接呼び出しで作るか | まず子会話、次に直接 | 費用・耐久 | 二重計上・再送 | V3 |
| U-04 | Python カーネルを持つか | 持たない。bash 都度 | データ分析 | 性能・利便 | V6 / 実利用 |
| U-05 | sandbox Worker の運用 | 別 Worker + DO | 配備 | 障害点が増える | V2 |
| U-06 | 実行予算の単位 | 会話ではなく実行ツリー | 課金 | 既存 limits との整合 | S1 |
| U-07 | イベント schema | 本文なし・長さ/ハッシュのみ | UI / 監査 | 情報不足 | S1 |
| U-08 | 子の結果を同期で返すか | 同期（深さ 1） | UX | 長時間ブロック | S1 |
| U-09 | 承認の要否 | network / 大量書き込みは承認 | 安全 | UX の摩擦 | V5 |
| U-10 | モデル別チューニング | 2 モデルで開始 | 品質 | プロンプト肥大 | V7 |

**既知のリスク（設計で閉じる）**:

- **注入**: リポジトリ内の文書が「秘密を読め」と指示し、コードが実行する。bwrap の hide と network 制限で閉じるが、ワークスペース内の `.env` は読める。V5 で実測する。
- **費用の裾**: 子の再帰で p95 が跳ねる。木全体の予算と早期停止（深さ・本数）で閉じる。
- **監査**: コードと出力を残さない方針は、再現性を落とす。長さ・ハッシュ・全文ファイルの参照だけを残し、必要なら R2 に短期限保存する。
- **モデル更新**: プロバイダのモデルが変わるとコード能力が変わる。V7 をリリース前の回帰にする。

---

## 10. 出典

### 一次資料

- Zhang, Kraska, Khattab. "Recursive Language Models." arXiv:2512.24601v3（2026-05-11）. https://arxiv.org/abs/2512.24601
- Prime Intellect. "Recursive Language Models: the paradigm of 2026." 2026-01-01. https://www.primeintellect.ai/blog/rlm
- Karten et al. "Prime Agent: A Self-Improving RLM Harness." arXiv:2608.23552. https://arxiv.org/abs/2608.23552
- Karten et al. "Continual Harness." arXiv:2605.09998. https://arxiv.org/abs/2605.09998
- prime-agent リポジトリ（MIT）. https://github.com/PrimeIntellect-ai/prime-agent （HEAD `fdc0761`、2026-11-17 取得）
  - `crates/pa-core/src/prompts/layers/core.md`（単一ツール・subagent・harness の正典）
  - `prime-agent-runtime/src/rlm/repl.md`（REPL プロトコル・snapshot/restore）
  - `crates/pa-core/src/tools/ipython.rs`、`kernel/manager/*`、`crates/pa-daemon/src/rlm_children/host.rs`
  - `crates/pa-core/src/refinement/*`（refine のゲート・ロールバック）
- alexzhang13/rlm（参照実装）. https://github.com/alexzhang13/rlm

### hns 内の根拠

- [docs/durability.md](../../docs/durability.md): `(C, J)`、Run 終了までの U、ack の RPO。
- [docs/safety.md](../../docs/safety.md): bwrap、fail closed、秘密の hide。
- [docs/limits.md](../../docs/limits.md): 会話単位の制限。木全体の予算は無い。
- [docs/observability.md](../../docs/observability.md): 引数・出力を残さない。
- [docs/packages.md](../../docs/packages.md): `agent` の `./session` は Worker-safe、`machine` は別配備。
- [packages/agent/src/agent.ts](../../packages/agent/src/agent.ts): ローカルの `openAgent` とツール登録。
- [packages/agent/src/tools.ts](../../packages/agent/src/tools.ts): `read_file` / `write_file` / `bash`。
- [packages/server/src/do/session.ts](../../packages/server/src/do/session.ts): Session DO の registry が空。
- [tools/deploy/cloudflare.config.ts](../../tools/deploy/cloudflare.config.ts): 別 Worker（gateway）の binding。
- [work/issues/0146-session-do.md](../issues/0146-session-do.md): ツール実行は non-goal。
- [work/issues/0147-machine-agent.md](../issues/0147-machine-agent.md): machine agent の範囲。
- [work/issues/0157-versioned-write-remote.md](../issues/0157-versioned-write-remote.md): リモート書き込み。

### 二次資料（追試・批判）

- rlm-replication-study. https://github.com/Cornjebus/rlm-replication-study （OOLONG の決定的集約ベースライン）
- rlm-reproduction. https://github.com/drbillwang/rlm-reproduction （S-NIAH / OOLONG の追試）
- "How to sandbox the RLM REPL." https://rlm.md/blog/how-to-sandbox-the-rlm-repl.html
- DSPy RLM. https://dspy.ai/current/api/modules/RLM/
- Cloudflare Sandbox. https://developers.cloudflare.com/sandbox/

### 注記

- 論文の数値は v3 の本文・表から取っているが、HTML の表組みの抽出に依存する箇所がある。確定判断に使う前に PDF の Table 1 を再確認する。
- prime-agent の README と実装には差がある（`context` 変数、ツール表面、TS 時代の記述）。本調査はコードを優先した。
- 追試の数値は小規模（20–50 問）で、hns の実務への外挿はできない。V1 の自前評価で置き換える。
