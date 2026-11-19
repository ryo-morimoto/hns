# Cloudflare backend の Git 互換 VCS 調査（GitHub）

2026-11-17 / 前提: オフライン review は高価値。Cloudflare に寄せる目的は「実行場所に依存せず作業を進める」こと。

## 0. 結論

- Cloudflare を backend にした Git 実装は **実在し、実用段階に近い**。中心は「repo ごとの Durable Object + R2」で、smart HTTP の clone / push、ref の直列化、pack の R2 退避まで実装されている。
- 選択肢は3層に分かれる。 (1) **埋め込める Git サーバ**（dgit が最有力、MIT・274★）、(2) **完成した forge**（r2g2 / gitfor / gitorange / gitstalk / ripgit）、(3) **Artifacts 上のツールキット**（gitmode など）。
- hns の「オフライン review」は、Artifacts を買わなくても **既存 R2 の C を Worker から読む**ことで取れる。これは新しいシステムを増やさない最小の形。git remote / handoff まで欲しくなったら **dgit を hns の Worker に埋め込む**のが次の候補。
- 完成 forge の採用は、hns の Conversation / Trail / 実行モデル（D047）と衝突するため採らない。

## 1. GitHub の候補（2026-11-17 時点）

| リポジトリ | ★ | License | backend | Git | 読み取り API | auth | 状態 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **littledivy/dgit**（durable-git） | 274 | MIT | DO（repo ごと SQLite）+ R2 pack cache | smart HTTP、clone / push / fetch、shallow / thin / ref-delete | cgit UI、JSON content API、typed RPC | 独自 authorize hook、push token | v0.0.8、2026-08 |
| **zllovesuki/git-on-cloudflare** | 82 | MIT | Workers + DO + R2 | Smart HTTP v2、streaming push、pack v2 | Web UI、raw / tree | Tessera OIDC + PAT | 2025-09 開始、最終 2026-05 |
| **deathbyknowledge/ripgit** | 172 | **AGPL-3.0** | Rust workers-rs + DO SQLite | smart HTTP、push / clone | Web UI、FTS5、refs / log / tree / diff API | service binding（upstream が actor header） | 2026-03 |
| **choyiny/gitorange** | 35 | Apache-2.0 | Workers + **Artifacts** + D1 + R2 + Containers | Artifacts の git | PR / review / findings / approvals / MCP | Cloudflare アカウント内 | 2026-10、AI agent 向け |
| **hassard0/r2g2** | 0 | MIT | Worker + R2 + D1 + DO + Queues | smart HTTP v2、push / clone、LFS | PR / review / merge queue / CODEOWNERS / 検索 | org / SSO / SCIM / 2FA（実装主張） | 2026-07、GitHub 級を主张 |
| **coop-collective/gitstalk** | 1 | Apache-2.0 | Workers + **Artifacts** + D1 + DO + Containers | git over HTTPS（SSH は実装済み・未開放） | Changes / History / MCP | 自前 | 2026-10、agent-first |
| **gitfor**（gitfor.dev/gitfor/platform） | — | **0BSD** | Workers + **Artifacts** + D1/KV/R2/Queues/Workflows/DO/Containers | Artifacts の git | PR / workflows / issues / security / sites | 自前 | 2026、self-host 可 |
| **teamchong/gitmode** | 3 | MIT | Workers + Artifacts + DO + R2 | Artifacts の git | prompt-blame / edge compute / WASM git | 自前 | POC、Artifacts 上に pivot |
| **imjasonh/playground git-server** | — | — | Rust→wasm + R2 + DO | smart HTTP v2、push / clone | file / tree / blame / diff API | なし（prototype） | 実験、benchmark あり |
| **nandan-varma/git-fs-s3** | 2 | AGPL-3.0 | isomorphic-git FS over S3/R2 | smart HTTP + ops 層 | branches / commits / diffs / history | 呼び出し側 | library、Node 22+、PushStack へ移管 |

★ は shields.io の取得値。— は GitHub 外（gitfor は自前 forge）または単一 README。

## 2. 深掘り

### dgit（durable-git）— 埋め込みの最有力

- **構造**: 1 repo = 1 Durable Object。objects / refs は cell の SQLite、pack は R2 に退避でき、full clone は R2 から直接 stream。
- **Git**: smart HTTP、pkt-line、packfile（ofs / ref-delta）、shallow / deepen / unshallow、thin pack、side-band、force update、ref delete。
- **API**: cgit 風 UI に加え、JSON content API（refs / log / tree / blob / diff / search）と typed RPC。`ui: false` で headless、`namespaces: true` で owner/name。
- **auth**: `authorize({ repo, op, private, credentials, env })` を差し替えられる。hns の Workspace DO が短命 token を発行し、repo 単位で検証できる。
- **運用**: push で `onPush` event、GC は DO alarm、`MAX_PUSH_MB`、`SHA1DC`。128MB / 5 分の Worker 制限があり、巨大 repo は celld（自前ノード）へ。
- **リスク**: v0.0.8、2026-08 開始、単独メンテ、PR は受け付けず format-patch。git 実装の正しさを hns が背負う。

### git-on-cloudflare — 完成アプリ寄り

- Workers + DO + R2 の Smart HTTP v2。streaming push、pack の range read、二層 cache、Web UI、Tessera OIDC + PAT。
- フルアプリなので、hns に埋め込むより「別 Worker として立てる」形。auth が Tessera 前提で、hns の認可に合わせるには改造が要る。

### ripgit — 検索と API が強いが AGPL

- Rust + workers-rs、DO SQLite、FTS5、refs / log / tree / file / diff / compare / search の API、text/markdown 交渉。
- **AGPL-3.0**。hns に組み込むと配布時のソース提供義務が問題になりやすい。採用するなら別サービス化と法務確認が前提。

### 完成 forge（r2g2 / gitfor / gitorange / gitstalk）

- PR / review / merge queue / CODEOWNERS / LFS / Actions / issues まで持つ。Cloudflare 上で完結する点は魅力的。
- ただし **hns の Conversation / Trail / 実行モデルを置き換える**。CI を Containers で実行するものは D047（Cloudflare でワークロードを実行しない）と衝突する。
- gitorange / gitfor / gitstalk は **Artifacts を git ストレージに使う**。Artifacts が基盤として使われている証拠になる一方、hns が採るなら Artifacts 依存は残る。

### Artifacts 上のツールキット（gitmode）

- prompt-blame（commit に prompt / session / model を付ける）、edge compute pool（diff / grep / blame を DO に fan-out）、WASM git。
- 「Artifacts は storage だけで compute を持たない」という缺口を突く。hns の review read path の設計参考になる。

## 3. オフライン review の取り方（hns）

| 案 | 仕組み | オフライン review | git remote / handoff | 複雑化 | 成熟度 |
| --- | --- | --- | --- | --- | --- |
| **A'. R2 read path（推奨・最短）** | checkpoint 時に manifest（path → object id）を書き、Worker が R2 の object を読んで diff | ○ | ×（patch export で代替） | 中（コードのみ、新システムなし） | hns 自身 |
| **D. dgit を埋め込む（次の候補）** | RepoCell DO + Registry + R2 を hns の Worker に追加。machine が push、UI は content API | ○ | ○ | 高（DO class・auth・upgrade） | v0.0.8、MIT |
| **B. Artifacts ミラー** | run 終わりに Artifacts へ push、UI は binding で読む | ○ | ○ | 中〜高（dual write） | beta |
| **C. Artifacts 正本** | C を Artifacts に移す | ○ | ○ | 高（移行・上限） | beta |
| **E. 完成 forge** | r2g2 / gitfor 等を採用 | ○ | ○ | 最高（製品置換） | 若い |

### 推奨

1. **オフライン review を要件として確定**し、まず **A'（R2 read path）** を作る。C は既に R2 にあり、新しいストレージや dual write を増やさない。
2. **D（dgit 埋め込み）を 1〜2 週間の spike** で試す。git remote / handoff と、restore / pack の自前実装を削れる可能性がある。`authorize` を Workspace DO の短命 token に差し替え、`ui:false` で hns の UI から content API を読む。
3. **B / C は D と A' の結果待ち**。Artifacts の managed 性（運用ゼロ）が複雑化コストを上回るなら B'（オンデマンド publish）から。
4. **E は採らない**。review / 実行モデルを置き換え、D047 と衝突する。

### A' の実装イメージ

- checkpoint 時に machine が manifest（path, mode, blob id）を R2 に書く（既存の object と dedupe）。
- Worker は manifest と blob を R2 から読み、base / head の manifest を比較して diff を作る。
- UI は Run の base / head を指定して file list / hunk / blob を取得。machine がオフラインでも読める。
- 二重保存なし。git object の pack を Worker で解く必要もない（manifest 方式）。

### D の spike 条件

- 1 workspace、1 repo、10〜100 push。
- 成功条件: machine オフラインで review が 1 秒以内、push が現行 checkpoint の 2 倍以内、fail 時の復旧が説明できる、hns の auth に合わせられる。
- 失敗条件: dgit の git 実装に欠落（LFS / 大きい push / sha256）、upgrade が追えない、DO SQLite の上限。

## 5. bit を backend に fork / embed する案の評価

### 5.1 bit の現在地（一次資料）

bit は「Git 実装 + AI sandbox 向けの拡張」で、CLI だけではない。

- **Git 本体**: 108 コマンド、git/t 97.6%、LFS、subdir clone、upload-pack v0/v2、receive-pack、pack bitmap / commit-graph / reftable。
- **実行環境**: WASI / in-memory を想定し、storage は FileSystem / RepoFileSystem の抽象。WASM component（component/wit の filesystem / http-client / git-ops）と JS host bridge（npm の BitBackend）を持つ。
- **分散・協調**: `bitx_kv`（P2P gossip）、`bitx_hub`（PR/issue を refs/notes に）、`bitx_wal`（WAL）、`bit_objstore`（object store + CAS）。
- **サーバ**: `bit serve --http`、smart HTTP の upload-pack / receive-pack ヘルパー、LFS batch、bearer auth。

### 5.2 ただし、Cloudflare backend には未達（bit 自身の docs）

`docs/scalable-git-server.md` は「phases 0–2 implemented, phases 3–7 not started. Nothing here is in a release yet」と明記している。残っている構造的な缺口は次の2つ。

- **G4: pack を丸ごとメモリに載せる**。`ObjectDb` は pack 全体を読み、`read_file` は whole-file のみ。repo サイズが RAM で上限になる（Workers は 128MB）。
- **G5: serving path が sync traits**。Workers/R2 は async traits が end-to-end で必要。
- **G7: 認証**。マルチ repo routing はあるが、per-repo policy / per-user auth はなく、単一の共有 bearer token。

さらに、`bit serve` はローカルの HTTP サーバで、ストリーミングや TLS、Workers の制限に合わせた実装は別途必要。

### 5.3 backend にするために足りないもの

- R2 / DO の object store adapter と、WAL / CAS の serving path への接続。
- pack の range read / streaming（G4）と async traits（G5）。
- repo 単位の短命 token、owner、private/public、監査（G7）。
- multi-repo registry、GC、abort / retry、観測。
- MoonBit ツールチェーン、WASM ビルド、bit 本体への追従、git 実装の正しさ。

### 5.4 比較

| 基準 | bit を fork | bit を read-only で embed | Artifacts（B: ミラー） |
| --- | --- | --- | --- |
| git remote までの距離 | 数か月〜（G4/G5/G7 + adapter） | 読み取りのみなら週単位（要検証） | 数日〜数週間 |
| Cloudflare backend | 自作 | 自作（read-only） | ネイティブ |
| 認証 / token | 自作 | 不要（読み取り） | repo 単位 token（TTL） |
| 耐久 / 運用 | 自作 | 自作 | managed（beta） |
| 言語 / ツールチェーン | MoonBit + TS | MoonBit/WASM + TS | TS のみ |
| 未完成リスク | 高い（実験的・G4/G5） | 中（読み取り限定） | beta・上限・ack 未確認 |
| two-way door | one-way（fork） | 中（spike） | two-way（ミラーを止める） |

### 5.5 結論

bit は **Cloudflare-native VCS の最良の参照実装**であり、将来の自前 backend の候補。ただし現時点で fork して backend にするのは、bit 自身が「未リリース・G4/G5 未解決」と言っている段階で、hns の git remote 要件には重すぎる。

- **今**: Artifacts B（ミラー）で remote とオフライン review を取る。
- **任意の低優先 spike**: bit の JS/component を Workers に載せ、R2 adapter で **read-only**（log / tree / diff）だけ動かす。動けば A' の代替になる。push server は G4/G5/G7 が解けるまでやらない。
- **fork して full backend**: Artifacts が使えない / 上限が足りない / セルフホスト必須、かつ MoonBit/WASM を保守できる体制がある場合の最後の手段。


bit（[bit-vcs/bit](https://github.com/bit-vcs/bit)）は MoonBit 製の Git 実装で、108 コマンド・git/t 97.6%・LFS・subdir clone・`bit serve`（smart HTTP）・relay・`bit/x/fs`（commit を lazy mount）を持つ。v0.49.1（2026-11-02）、約 75★、Apache-2.0、実質単独メンテ。

## 6. 参考

- dgit: https://github.com/littledivy/dgit / https://www.npmjs.com/package/durable-git
- git-on-cloudflare: https://github.com/zllovesuki/git-on-cloudflare
- ripgit: https://github.com/deathbyknowledge/ripgit
- gitorange: https://github.com/choyiny/gitorange
- r2g2: https://github.com/hassard0/r2g2 / https://r2g2.dev
- gitstalk: https://github.com/coop-collective/gitstalk / https://gitstalk.io
- gitfor: https://gitfor.dev/ / https://gitfor.dev/self-host
- gitmode: https://github.com/teamchong/gitmode
- imjasonh git-server: https://github.com/imjasonh/playground/tree/main/git-server
- git-fs-s3: https://github.com/nandan-varma/git-fs-s3
- 関連: [review-experience-and-decisions](review-experience-and-decisions.md) / [cloudflare-artifacts](cloudflare-artifacts.md)
