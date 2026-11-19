# Cloudflare Artifacts の競合・OSS 徹底調査

2026-11-17 / 関連: [Artifacts 適用調査](cloudflare-artifacts.md) / 対象: agent 向け repo ストレージ、Git ホスティング、セルフホスト OSS、実行基盤の snapshot、データバージョニング

## 0. 結論

1. **2026 年に入って「エージェント用の Git 保存層」が新しいカテゴリになった。** 直接の競合は Cloudflare Artifacts だけではなく、Coregit、Mesa、artifact.storage（Constal）、Entire、Upstream（Coline）、Onset、Oak、Reef、Forge がひしめく。Artifacts はその中で**唯一 Cloudflare アカウント内の binding として動き、ローカルシミュレータを持つ**製品。
2. **git 互換 + repo 単位 token + fork + マネージドを同時に満たすものは、依然として Artifacts が最良の fit。** ただし仕様の余裕では負ける（Mesa は 50GB 無料、Coregit は COW の instant fork、ファイル上限も緩い）。勝っているのは統合・価格・標準 Git への素直さ。
3. **既存のマネージド Git（GitHub / GitLab / Bitbucket / Azure / CodeCommit）は「人間のチーム」向けで、repo をセッション単位で量産し、短命 token を配り、fork を湯水のように使う用途には設計されていない。** 価格も per-seat で、上限も repo 単位 1〜10GiB が普通。
4. **セルフホストの現実解は Forgejo / Gitea。** GitLab CE は重く（16GB/8vCPU baseline）、Soft Serve は sunset / archived。新しい OSS VCS（Onset / Oak / Reef / Forge）は「エージェントの並列 writer」に最適化されているが、**git プロトコル互換ではなく、hns の checkpoint 引き渡し（git fetch）を失う**。
5. **実行基盤の snapshot（E2B / Daytona / Modal / Vercel / Cloudflare Sandbox）は checkpoint の正本にならない。** 履歴・diff・移植が無く、TTL で消える。hns の「C は git commit」という選択は、このカテゴリの製品と競合せず、上位で使うのが正しい。

### 調査方法と確度

- 直接競合（Artifacts / Coregit / Mesa / artifact.storage / Entire / Upstream / Supafork）は**公式ページを取得して確認**した。Coregit は docs が 402 のため、検索結果のスニペットと公開ページのみ。
- マネージド Git の上限・価格は公式 docs の該当記述を確認（GitLab 10GiB、Bitbucket 1GB/4GB、Azure 10GB/250GB、Codeberg 750MiB、Secure Source Manager $1,000/instance）。GitHub の 5GB 推奨・100MiB/file は公式 docs の既知値。
- 実行基盤・データバージョニングの一部（E2B の月額、Vercel の Hobby 上限、Daytona のセルフホスト可否など）は**二次情報または未確認**を含む。本文で「未確認」と付けた箇所は断定しない。
- 価格・上限は 2026-11-17 時点。この分野は数か月で変わるため、採用直前に再確認する。

## 1. 市場の地図

    [実行環境]  E2B / Daytona / Modal / Runloop / Morph / Vercel Sandbox / CF Sandbox / Coder
                        │ snapshot（FS+mem, TTL, diff なし）
                        ▼
    [保存層]    Cloudflare Artifacts / Coregit / Mesa / artifact.storage / Forgejo / GitLab
                        │ git commit / branch / fork / repo token
                        ▼
    [レビュー]  Entire / Upstream / GitHub / GitLab / hns の UI

- **Artifacts の直接競合**は「保存層」の 4 製品（Coregit, Mesa, artifact.storage, そして OSS の Forgejo）。
- **Entire / Upstream** は「レビュー層」の競合で、hns の会話・差分 UI と発想が近い。保存は自前 forge か GitHub ミラー。
- **Onset / Oak / Reef / Forge** は「VCS そのもの」をエージェント向けに作り直す OSS。保存層とレビュー層を同時に置き換える。**bit** は Git 実装 + ローカル forge + AI サンドボックスの部品で、保存サービスではない（§4.3）。
- **Supafork** はコードではなく**セッション・プロンプト・ツール呼び出しの保存**で、hns の Session DO / D1 と隣接する（Pi ハーネスも対応）。

## 2. 直接競合（agent-native な repo ストレージ / forge）

| 製品 | 形態 | git 互換 | repo 作成 API | token | fork | 遅延マウント | 上限 | 価格 | 成熟度 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Cloudflare Artifacts** | マネージド（CF アカウント内） | ◎ 完全（smart HTTP） | ◎ binding / REST / Wrangler | ◎ repo 単位・read/write・TTL | ○ repo fork（objects 数は返すが COW かは未確認） | ○ ArtifactFS（FUSE、blobless clone） | 1GB/repo、32MiB/file、64MiB/push | ◎ $0.15/1k ops、$0.50/GB-mo（10k ops / 1GB 無料） | open beta、2026-11-19 課金開始 |
| **Coregit** | マネージド API（api.coregit.dev） | ◎ 標準 Git + REST | ◎ POST /v1/repos | ◎ repo 単位スコープ・時間制限 | ◎ instant fork（ref snapshot + 共有 CAS、コピーなし） | ◎ fs.mount()（in-process、lazy read、bash exec） | 不明（docs が 402） | 従量（公開ページ取得不可） | 2026-04 ローンチ。**docs が 402 / deployment paused（2026-11-17 時点）** |
| **Mesa** | マネージド VFS（SDK） | ○ Git + REST（egress に Git を含む） | ◎ repos.create | ◎ private key / SDK | ◎ fork（並列 swarms 前提） | ◎ in-process VFS（egress 無料） | 50GB 無料、repo 数 1,000 無料 | $0.20/GB-mo、$0.11/GB egress、VFS は無料 | early access |
| **artifact.storage**（Constal） | マネージド（Coming Soon） | ◎ Git + REST + ArtifactFS | ◎ 1 API call / agent | ○ token（repo 単位） | ○ read-only fork（レビュー用） | ◎ ArtifactFS | 1GB/repo、account 無制限 | $1.50/GB-mo、$1/1k ops、$0.01/GB egress | **Coming Soon**（未提供） |
| **Entire** | マネージド forge | ◎ Git（GitHub ミラー） | ○ repo 作成 / mirror | ○ 組織・GitHub 権限連携 | △ Trail（PR の置き換え） | × | 不明 | early access（credit 制） | 2026-10 発表、SOC 2 進行中 |
| **Upstream**（Coline） | マネージド forge | ◎ Git（HTTPS/SSH） | ○ repo 作成 | ○ 人/チーム権限 | ○ fork / Change Request | × | Free 100 repos、1GiB LFS | Free / $20/user/月〜 | alpha |
| **Supafork** | メタデータ保存（コードではない） | ×（セッション同期） | ○ repo 登録 | ○ | × | × | 不明 | beta 無料 | beta |

### 各製品の要点

**Coregit** — 一番「Artifacts の上位互換」に見える。1 API コールで複数ファイルを atomic commit、fork は「親の ref をスナップショットして参照カウントの辺を張る」だけでミリ秒、blob はグローバル CAS で共有。fs.mount() は in-process の versioned FS で、read は lazy、bash().exec() はサーバ側実行。2026-04 ローンチ。**ただし調査時点で docs が 402（deployment paused）で、料金・上限・SLA を一次資料で確認できない**。hns の「実行は自分のマシン」とサーバ側 bash は思想が逆。

**Mesa** — 「versioned filesystem for AI agents」。SDK から repo を作り、mesa.fs({ layout: ... }) で in-process mount、write/read/bash を実行。fork・checkpoint・rollback・承認フロー・あらゆるファイル形式を前面に出す。**50GB 無料、VFS は egress 無料**で、Artifacts の 1GB/repo に悩むなら最有力の代替。ただし early access、Cloudflare binding なし、外部 API。

**artifact.storage** — Constal の 3 製品（runtime / caas.sh / artifact.storage）の保存層。**ArtifactFS を使うと明記**しており、Cloudflare Artifacts の上に UX をかぶせたレイヤーの可能性がある（未確認）。料金は Artifacts より高い（$1.50/GB-mo、$1/1k ops）が、repo 無制限・1GB/repo・Git notes で agent/session を記録。Coming Soon で現時点では選べない。

**Entire** — Thomas Dohmke（元 GitHub CEO）が 2026-10 に発表した「agent-human collaboration の Git forge」。PR の代わりに **Trail**（意図・コード・セッション・レビュー証跡をまとめる単位）、eval・risk・slop モニタ。GitHub ミラーと Entire ホスト repo を持つ。SOC 2 進行中。**保存層ではなくワークフロー製品**で、hns のレビュー UX の競合。

**Upstream** — Coline の「最速 Git forge」。Git push 速度を GitHub の 2,000 倍と主張、Change Request（stack 可能）、CODEOWNERS、merge queue、agent 向け onboarding「Rapid Onset」。Free 100 repos / Pro $20/user。alpha。**Entire と同じく forge 製品**で、保存 API としては使わない。

**Supafork** — 「The Source of Truth for your Agents」。プロンプト・セッション・ツール呼び出し・スキルを harness 横断で保存し、sf init で取り込む。Pi / Claude Code / Codex / OpenCode などに対応。**コードの保存ではなく、agent の記憶の保存**。hns の Session DO と発想が近く、差別化要素になり得る。

## 3. 既存のマネージド Git ホスティング

| 製品 | repo 作成 API | token | fork | 1 repo の目安 | 価格 | セルフホスト |
| --- | --- | --- | --- | --- | --- | --- |
| **GitHub** | REST / GraphQL / gh | fine-grained PAT（repo 単位・期限付き） | ○ | 5GB 推奨、100MiB/file | Free〜$4/user/月 | × |
| **GitLab**（SaaS） | REST / GraphQL | project access token（期限付き） | ○ | Free 10GiB/project、Premium 500GiB | Free〜 | ○（CE、MIT） |
| **Bitbucket Cloud** | REST | workspace/repo access token | ○ | Free 1GB/workspace、4GB 上限 | Free〜 | ×（DC は別） |
| **Azure Repos** | REST | PAT（期限付き） | ○ | 10GB 推奨、250GB pack 上限 | per-user | ×（Server は別） |
| **AWS CodeCommit** | API / Git | IAM（repo 単位） | ○ | 実質無制限（サービス上限に依存） | per active user | × |
| **Google Secure Source Manager** | API / Git | IAM | ○ | インスタンス依存 | **$1,000/instance/月** | ×（single-tenant マネージド） |
| **Codeberg**（Forgejo） | Gitea/Forgejo API | token（スコープ付き） | ○ | **750MiB/repo** | 無料（寄付） | —（Forgejo を自前で） |
| **SourceHut** | GraphQL / git | OAuth / SSH | ○ | 従量 | $2〜/月 | × |

- **GitHub / GitLab は「repo を大量に作り、短命 token を配る」ことに技術的には使える**が、per-seat 課金・API レート・fork のコピーコスト・1 repo あたりの履歴肥大が、エージェントのセッション単位運用と噛み合わない。GitHub の fine-grained PAT は repo 単位で期限も切れるので、**hns がどうしても既存 forges を使うなら現実的な選択**ではある。
- **AWS CodeCommit は 2024-07 に新規受付を止め、2025-11-24 に GA へ戻った**（[AWS blog](https://aws.amazon.com/blogs/devops/aws-codecommit-returns-to-general-availability/)）。IAM で repo 単位に権限を切れる点は hns 向きだが、per active user 課金と AWS 依存が増える。
- **Google Cloud Source Repositories は 2024-06-17 以降、新規顧客に提供していない**。移行先は Secure Source Manager（$1,000/instance/月）で、個人〜小規模には重い。
- **Codeberg は 750MiB/repo**（[2025-05 の新 quota](https://blog.codeberg.org/new-storage-limits-on-codeberg-what-you-need-to-know.html)）で、Artifacts 以上に容量が厳しい。公開 OSS の置き場であり、エージェントの作業 repo には向かない。

## 4. OSS

### 4.1 セルフホスト Git サーバ

| 製品 | ライセンス / 実装 | repo 作成 | token | fork | 強み | 弱み |
| --- | --- | --- | --- | --- | --- | --- |
| **Forgejo** | GPL-3.0+ / Go | API / UI | repo 限定 scope の token（**TTL なし**） | ○（Gitea 互換） | Gitea 互換、Actions、LFS、Codeberg 実績、コミュニティ主導 | 自前運用（DB・ストレージ・backup）、fork はコピー |
| **Gitea** | MIT / Go | API / UI | スコープ付き PAT（**TTL なし**。短命化は broker が要る） | ○ | 単一バイナリ、軽量、LFS/Actions/Packages | 同じく運用、機能は Forgejo と分岐 |
| **GitLab CE** | MIT / Ruby + Gitaly | API | project access token（期限必須） | ○（**非同期 job**） | CI 込みの完成度、企業実績 | 重い（baseline 16GB/8vCPU、Postgres/Redis/Gitaly/object storage） |
| **Soft Serve** | MIT / Go | SSH コマンドのみ（REST なし） | SSH 鍵・user token（repo scope なし） | × | 単一バイナリ、SSH だけで完結、TUI | **sunset / archived でセキュリティ更新なし。採用不可** |
| **OneDev** | MIT / Java | API / UI | access token（project/role 制限・期限可） | △（UI のみ、fork API なし） | 単一プロセスで CI・issue・検索まで | fork を API で回せない |
| **Gerrit** | Apache-2.0 / Java | SSH / REST | ユーザー単位（repo token なし） | ×（概念なし） | レビュー文化、大規模実績 | 学習コスト・運用が重い、agent 向きでない |
| **Gogs** | MIT / Go | API / UI | token | ○ | 最小 | 開発停滞気味 |
| **Radicle** | Apache-2.0 / P2P | CLI（サーバ不要） | 鍵 | × | 分散・検閲耐性 | ホスティング API / token / fork がない。ミラー向き |

**token の TTL が実は重要な差**: Gitea / Forgejo の PAT はモデルに有効期限がなく、repo 単位に絞る scope も限定的（Gitea の fine-grained token は Enterprise 版）。**エージェントごとに短命 token を配るなら、broker を自作するか Artifacts のように期限付き repo token を買う**ことになる。**エージェントに直接渡すなら token broker（自前で短命 token を発行し、PAT は broker の内側に閉じる）が必須**になる。Artifacts は repo token に expires が付くので、この層を買える。

**ArtifactFS は Artifacts 専用ではない**: cloudflare/artifact-fs は任意の Git remote を mount できる独立した FUSE ドライバで、Forgejo や GitHub の repo にも使える。したがって「遅延マウント」は Artifacts を選ぶ理由にならず、Artifacts の価値は**運用ゼロ・Cloudflare binding・価格**に寄る。

**hns にとっての現実解は Forgejo**（Gitea でも可）。Artifacts の代替として選ぶなら「Cloudflare 依存を減らす」代わりに「DB・object storage・backup・監視」を自前で持つ。単一ユーザーなら 1 台で足りるが、hns の「セルフホスト = UI とサーバのコードを自分で動かす」という定義（D047）を満たす範囲は広がる。

### 4.2 エージェント向け OSS VCS（新興）

| 製品 | ライセンス | モデル | git 互換 | 状態 |
| --- | --- | --- | --- | --- |
| **Reef** | Apache-2.0 | git の CAS を保ちつつ、leased copy-on-write workspace・typed API・MCP・証跡/提案/landing | 部分（git の object model を利用） | 0.4.2（2026-11）、Phase 3 進行中 |
| **Onset**（Coline） | 公開リポジトリ（ライセンス未確認） | CLI 'on'、サーバが land を到着順にマージ、多数 agent が 1 main に | ×（独自） | public preview（2026-11-13） |
| **Oak** | Apache-2.0 | branch = 1 セッション、内容定義チャンク（BLAKE3）、shallow/sparse clone、server + web | ×（独自、git backend は任意） | 0.114 系、活発 |
| **Forge** | MIT | ローカル .forge に変更のライフサイクル（start→save→run→propose→check→accept）と証跡、Git へ export | 輸出時のみ | RC（v0.1.0-rc10） |
| **jj (Jujutsu)** | Apache-2.0 | クライアント側 VCS、git backend | ○（git repo を操作） | 実用、サーバなし |
| **Sapling / EdenFS** | MIT（Sapling）/ GPL-2.0（EdenFS） | クライアント VCS + 仮想 FS（FUSE/NFSv3/ProjFS）。ホスティング API は無い | ○（git 互換レイヤ） | 大規模実績、サーバ運用は未公開・重い |

- **Reef は hns の設計に一番近い**。「leased copy-on-write workspace」は hns の lease / INV-13 と同型で、git の CAS を保つ。ただし独自の working model・API で、hns の「checkpoint を git commit として R2/Artifacts に置く」経路をそのまま置き換えるものではない。**思想の参考元として読む価値が高い**。
- **Onset / Oak は git 非互換**。採用すると hns の「人間が git fetch で Run を持ち帰る」「Git Diff Viewer」が成立しなくなる。プロトコルごと置き換える覚悟が要る。
- **Sapling/EdenFS は virtual FS の完成度が高い**が、サーバ側の運用は非公開・大規模前提で、個人〜小規模の hns には過剰。

### 4.3 bit（MoonBit 製 Git 実装 + AI サンドボックス）

mizchi が 2026-01 に始めた **MoonBit 製の Git 実装**（Apache-2.0、v0.49.1 / 2026-11-02、GitHub stars 約 60〜75）。git/t の 97.6%（24,278 / 24,858、broken 178）を通すと主張し、WASM/WASI を意識して IO を抽象化している。**保存サービスではなく「Git そのもの + ローカル forge + エージェント用サンドボックスの部品」**で、Artifacts / Coregit / Mesa の直接競合ではない。

| 機能 | 内容 | hns との関係 |
| --- | --- | --- |
| git 互換 | 108 コマンド、git/t 974 テスト。SHA-256 repo、GPG 署名、Windows、JS ターゲットの SSH transport は非対応 | hns は real git で足りる |
| `bit serve` | smart HTTP で repo を配信。`--allow-push --token`、TLS なし・全リクエストをメモリに保持 | マシン上のローカル用途のみ。hns は inbound を開けない |
| `bit relay` | 単一 repo を relay 経由でトンネル（bit-relay は TypeScript/Deno） | NAT 越しの store-and-forward。hns は cloudflared + DO で代替済み |
| `bit pr` / `bit issue` | PR/issue を Git object / notes（refs/notes/bit-hub）に保存し、relay で同期 | hns のレビュー UX の参考（forge なしで PR を持つ） |
| `bit/x/fs` | commit を lazy blob で FS として mount。任意の状態へ rollback | ArtifactFS と同型。hns の restore / U の扱いの参考 |
| ネイティブ LFS | LFS pointer の clone/checkout/add/push を git-lfs なしで処理 | **32MiB 問題の逃がし先の実装候補** |
| subdir clone | 任意のサブディレクトリを独立 repo として双方向 clone | 巨大 monorepo の部分作業に有用 |
| `bit ai` | rebase/merge/cherry-pick の AI 解決（OpenRouter） | hns の Agent とは層が違う |

**評価**: 実験的（README に「production で使うな、最悪 history を壊す」と明記）、単独メンテナ、MoonBit ランタイム。**hns の checkpoint 正本には採用できない**（repo 量産 API・repo 単位 token・fork・耐久性の契約がない）。ただし、**lazy FS・native LFS・subdir clone・git notes 上の PR** は、hns が自前で作る部分の設計参考になる。特に LFS は Artifacts の 32MiB 制限に対する実装候補として読む価値がある。

**未確認**: JS/WASM ターゲットが Cloudflare Workers で実用になるか、relay の認証・暗号化、性能（pack 処理・大きい repo）。

## 5. エージェント実行基盤（snapshot 系）— 正本にはならない

| 製品 | snapshot の単位 | fork | git | TTL | セルフホスト | 価格の目安 |
| --- | --- | --- | --- | --- | --- | --- |
| E2B | sandbox（FS+mem） | ○ | × | pause は無期限 | ×（BYOC は managed） | $150/月〜 + 秒課金 |
| Daytona | VM（FS+mem、lineage） | ○ | × | 停止中も disk 課金 | ×（OSS は archived） | 予約リソース従量 |
| Modal | Image / snapshot | ○（Image 化） | × | FS 30 日 / mem 7 日 | × | 秒課金 |
| Runloop | disk snapshot | ○（disk のみ） | × | 無期限（storage 課金） | × | $250/月〜 |
| Morph | instance（FS+mem） | ○ | × | TTL 設定可 | × | 従量 |
| Vercel Sandbox | sandbox（Firecracker） | ○ | × | Hobby 45 分 | × | CPU/GB 秒 |
| CF Sandbox SDK | container（FS） | ○（β） | ×（Artifacts は別） | 30 日 | × | Workers Paid + 従量 |
| Coder | workspace（Terraform） | ×（template 複製） | × | 自前 | **○（AGPL-3.0）** | 無料 / Enterprise |
| Ona | environment | × | × | — | ×（runner のみ自 VPC） | Enterprise |
| Fly.io | volume | ○（full copy） | × | snapshot 1〜60 日 | × | $0.15/GB-mo |

**要点**: snapshot は「実行環境の複製」であり、commit 履歴・diff・per-repo token を持たない。**checkpoint の正本にすると、レビューも移植もできず、TTL で消える**。hns の (C, J) 設計と競合しない。Cloudflare Sandbox の S3Mount は R2 を資格情報なしでマウントでき、**大ファイルの逃がし先**としてだけ価値がある。

## 6. データバージョニング / VFS（隣接）

| 製品 | 意味論 | git 互換 | fork | 遅延マウント | ライセンス | hns への示唆 |
| --- | --- | --- | --- | --- | --- | --- |
| lakeFS | object store 上の branch/commit/merge（3-way） | 部分 | ×（branch がゼロコピー） | Enterprise のみ | **BSL 1.1（1.87.0〜、未改変・内部利用限定）** | 意味論は近いが、組み込みはライセンスで止まる |
| Nessie | Iceberg/Delta のカタログ | × | ×（branch） | × | Apache-2.0 | テーブル向け、ファイルツリー不可 |
| Dolt | SQL の行・セル単位 merge | × | ○ | × | Apache-2.0 | structural sharing の参考 |
| Oxen | merkle tree + CAS、大容量 | × | 未確認 | × | Apache-2.0 | 自前 VCS の第 2 候補 |
| HF Xet | chunk dedupe + LFS 互換 | ○（git-xet） | × | × | クライアントのみ OSS | 大ファイル層の設計参考 |
| Tigris | S3 + bucket snapshot/fork（COW） | × | ○（bucket） | × | マネージド | fork 可能なオブジェクトストレージ |
| JuiceFS / SeaweedFS | POSIX on object storage | × | × | ○（FUSE） | Apache-2.0 | 大ファイルの置き場 |
| IPFS / s3git | CAS | × | × | △ / × | OSS | 参考のみ（s3git は 2016 年で停止） |
| git-lfs（giftless / rudolfs） | git + LFS | ◎ | ホスト依存 | 不要 | MIT | **32MiB 超の逃がし先の本命** |
| Perforce P4 | changelist + stream | × | × | 部分 | 商用 | 大容量バイナリの参考 |

**要点**: 32MiB/file・1GB/repo は「層を分ける」で解くのが正解。**コードと小さいファイルは git（Artifacts）、32MiB 超は R2 の content-addressed blob + pointer（git-lfs 形式が無難）**。GC は hns 側で mark-and-sweep を持つ（Artifacts に GC API がないため）。

## 7. hns の判断材料

### 7.1 評価軸（hns の要件に照らす）

| 軸 | 重み | Artifacts | Forgejo 自前 | Coregit | Mesa | GitHub/GitLab |
| --- | --- | --- | --- | --- | --- | --- |
| 標準 git で clone/push できる | 高 | ◎ | ◎ | ◎ | ○ | ◎ |
| repo を API で量産・短命 token | 高 | ◎ | ○ | ◎ | ◎ | ○ |
| fork / COW が安い | 中 | ○（要検証） | △（コピー） | ◎ | ◎ | △ |
| 遅延マウント（大きい repo） | 中 | ○（ArtifactFS） | ○（ArtifactFS 併用） | ◎（in-process） | ◎（VFS） | ○（ArtifactFS 併用） |
| 上限の余裕（1GB/32MiB） | 高 | × | ◎（disk 次第） | 不明 | ◎（50GB） | ○（5〜10GB） |
| 既存 hns（CF・DO・D1）との統合 | 高 | ◎（binding） | △（別運用） | △（外部 API） | △（外部 API） | △（外部） |
| セルフホスト / lock-in 回避 | 中 | × | ◎ | × | ×（Enterprise で自前） | × |
| 価格（単一ユーザー） | 中 | ◎ | ○（運用込み） | 不明 | ○ | ○ |
| 成熟度 | 高 | ○（open beta） | ◎ | ×（docs 402） | △（early access） | ◎ |
| 「実行をクラウドに置かない」 | 高 | ◎ | ◎ | ×（bash exec） | ×（bash exec） | ◎ |

### 7.2 Artifacts の立ち位置

- **勝ち筋**: Cloudflare アカウント内で完結する binding、ローカルシミュレータ、標準 Git、repo 単位 token、fork、安い従量。**「hns の C をそのまま置ける」のは Artifacts だけ**。
- **負け筋**: 1GB/repo・32MiB/file・GC なし・open beta。Mesa（50GB 無料）や Coregit（instant fork）の方が仕様は強い。ただし両者は外部 API で、hns の「Cloudflare に正本、実行は手元」という構成に余分なベンダーと経路が増える。
- **要注意**: Coregit は docs が 402 で停止中（2026-11-17）。artifact.storage は Coming Soon。このカテゴリは**まだ生存者が固まっていない**。

### 7.3 代替シナリオ

| シナリオ | 中身 | 利点 | 欠点 |
| --- | --- | --- | --- |
| **A. Artifacts を C の正本に**（推奨） | workspace = repo、Run = branch | 統合・価格・標準 Git。R2 の pack/GC を削れる | 1GB/32MiB、beta 依存 |
| **B. Artifacts はミラー、R2 が正本** | 表示・引き渡し・fork だけ Artifacts | 失敗しても正本が壊れない | 二重保存、実装が二系統 |
| **C. Forgejo を自前運用** | 1 台に Forgejo + R2 backup | lock-in なし、上限は disk 次第 | 運用（DB/backup/監視）、fork はコピー |
| **D. Coregit / Mesa に寄せる** | 外部 API を保存層に | 上限・fork・VFS が強い | 外部依存、beta、Cloudflare 統合なし、bash exec と思想衝突 |
| **E. OSS VCS（Reef / Onset / Oak）** | プロトコルごと置換 | エージェント並列 writer に最適化 | git 互換を失う、若い、hns の設計をやり直す |

**推奨は A（段階的に B から）**。C は「Cloudflare を使わない」要件が出たときの逃げ道。D/E は保存層の乗り換えではなく製品の作り直しに近い。

## 8. 次の一歩

1. **Artifacts の fork が COW か（保存量が増えないか）を本番で測る。** Coregit/Mesa の instant fork との差がここに出る。
2. **32MiB 超の file を LFS 形式の pointer で R2 に逃がす規約**を決める（既存の objects.ts を活かす）。
3. **1GB/repo の世代管理**（workspace-g2、read-only 化、保持期間）を 0168 に反映する。
4. **保存層の境界を抽象化**（checkpoint の push/fetch を 1 インターフェースに）。Artifacts / Forgejo / Mesa を差し替え可能にしておく。
5. **Mesa と Coregit の無料枠で同一シナリオを試す**（1 workspace、push/fetch/fork/読み）。乗り換えコストを見積もる。
6. **Entire / Upstream の Trail / Change Request は UX の参考**として読み、hns の差分レビューに取り込む（保存層の採用とは切り離す）。

## 9. 参照

**Artifacts / 直接競合**
- [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/) / [product page](https://www.cloudflare.com/products/artifacts/) / [launch blog (2026-04-16)](https://blog.cloudflare.com/artifacts-git-for-agents-beta/)
- [Coregit](https://coregit.dev/) / [docs: forks](https://docs.coregit.dev/docs/api-reference/forks)（2026-11-17 時点 402）
- [Mesa](https://www.mesa.dev/) / [pricing](https://www.mesa.dev/pricing)
- [artifact.storage](https://artifact.storage/) / [pricing](https://artifact.storage/pricing) / [Constal](https://constal.ai/products)
- [Entire](https://entire.com/) / [Trails docs](https://docs.entire.com/guides/trails/overview) / [launch post](https://entire.com/blog/the-git-forge-for-agent-human-collaboration)
- [Upstream](https://upstream.codes/) / [pricing](https://upstream.codes/pricing)
- [Supafork](https://www.supafork.com/)

**マネージド Git**
- [GitHub repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits) / [large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)
- [GitLab storage](https://docs.gitlab.com/user/storage_usage_quotas/) / [Bitbucket size limits](https://support.atlassian.com/bitbucket-cloud/docs/reduce-repository-size/) / [Azure Git limits](https://learn.microsoft.com/en-us/azure/devops/repos/git/limits)
- [AWS CodeCommit returns to GA (2025-11-24)](https://aws.amazon.com/blogs/devops/aws-codecommit-returns-to-general-availability/)
- [Cloud Source Repositories migration](https://docs.cloud.google.com/source-repositories/docs/csr-ssm-migration-guide) / [Secure Source Manager pricing](https://cloud.google.com/products/secure-source-manager/pricing)
- [Codeberg storage limits](https://blog.codeberg.org/new-storage-limits-on-codeberg-what-you-need-to-know.html)

**OSS**
- [Forgejo](https://forgejo.org/) / [Gitea](https://gitea.com/) / [GitLab CE](https://gitlab.com/gitlab-org/gitlab) / [Soft Serve](https://github.com/charmbracelet/soft-serve) / [OneDev](https://github.com/theonedev/onedev) / [Gerrit](https://www.gerritcodereview.com/)
- [Reef](https://github.com/reef-vcs/reef) / [Oak](https://github.com/oakdotspace/oak) / [Forge](https://github.com/forge-vcs/forge) / [Onset](https://upstream.codes/coline/onset) / [jj](https://github.com/jj-vcs/jj) / [Sapling](https://github.com/facebook/sapling)
- [bit](https://github.com/bit-vcs/bit)（MoonBit 製 Git 実装）/ [bit-relay](https://github.com/bit-vcs/bit-relay) / [紹介記事](https://zenn.dev/mizchi/articles/introduce-bit-by-moonbit)

**実行基盤 / データ**
- E2B / Daytona / Modal / Runloop / Morph / Vercel Sandbox / [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) / [Coder](https://coder.com/) / Ona（各公式 docs）
- [lakeFS](https://docs.lakefs.io/) / [Dolt](https://github.com/dolthub/dolt) / [Oxen](https://github.com/Oxen-AI/Oxen) / [Xet](https://huggingface.co/docs/hub/xet/index) / [Tigris](https://www.tigrisdata.com/docs/) / [JuiceFS](https://github.com/juicedata/juicefs) / [git-lfs (giftless)](https://github.com/datopian/giftless)
