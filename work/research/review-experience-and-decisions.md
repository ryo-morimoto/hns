# 責務の分解とレビュー体験の設計

2026-11-17 / 関連: [Artifacts 適用調査](cloudflare-artifacts.md) / [競合・OSS 調査](cloudflare-artifacts-competitors.md)

## 0. この文書の目的

これまでの調査は「Artifacts を採るか」という1つの問いに、保存・復元・レビュー・引き渡し・並列探索・バックアップを混ぜていた。そのため、Artifacts の長所（binding・価格）とレビュー体験の長所（diff・履歴・引き渡し）が同じ議論に入り、判断ができなくなっていた。

この文書は、**責務を分けて、それぞれを独立に決められる形にする**。特にレビュー体験は、保存層の選択と切り離して先に設計できる（そして今いちばん面白い）ので、後半で深掘りする。

**最大の結論**: レビューは作る。保存は買う候補だが、いまは複雑化しない（R2 のまま）。レビュー体験は保存層に依存しない。Run の base / head の commit id と session id さえあれば、R2 でも Artifacts でも Forgejo でも同じレビュー面が作れる。Artifacts の採用理由にレビューを混ぜない。

## 1. 混ざっていた責務

| # | 責務 | これまでの議論で混ざった例 | 独立して決められるか |
| --- | --- | --- | --- |
| R1 | 正本の保存（C の object、J の本文） | 「Artifacts にすると UI から差分が読める」 | ○（commit id があれば上位は同じ） |
| R2 | repo の粒度・保持・GC | 「1GB/repo だから世代管理が要る」 | △（保存先の上限に依存） |
| R3 | 実行環境と作業ツリー | 「Artifacts なら restore が速い」 | ○（実行はマシン、保存は別） |
| R4 | 引き渡し・復元 | 「git fetch で人間が持ち帰れる」 | ○（git 互換なら何でもよい） |
| R5 | **レビュー体験** | 「Trail のように diff と根拠をまとめる」 | ○（commit range と session で決まる） |
| R6 | 来歴・メタデータ | 「git notes に prompt を入れる」 | ○（DO/D1 でも notes でもよい） |
| R7 | 並列探索 | 「fork で N 案を並べる」 | △（fork のコストに依存、UX は独立） |
| R8 | バックアップ・export | 「clone がバックアップになる」 | ○ |
| R9 | 課金・ベンダー依存・運用 | 「beta だから危ない」 | ○（契約で吸収できる） |

混ぜないための境界は「契約」で引く。次の4つだけ決めれば、R1〜R9 は別々に動かせる。

### 1.5 製品を責務で分類

| 製品 | 保存層 | 実行層 | レビュー層 | VCS | 来歴 |
| --- | --- | --- | --- | --- | --- |
| Cloudflare Artifacts | ◎ | × | × | git 互換 | notes 任意 |
| Coregit | ◎ | △（bash exec） | × | git 互換 | notes 任意 |
| Mesa | ◎ | △（VFS bash） | × | git 互換（部分） | × |
| artifact.storage | ◎ | × | △（read-only fork・notes） | git 互換 | notes |
| Entire | ○（forge） | △（cloud review agents） | ◎ | git | ◎ |
| Upstream | ○（forge） | × | ◎ | git | ○ |
| Reef | ○ | × | △（証跡・提案） | 部分（git CAS） | ◎ |
| Oak / Onset | ○ | × | △ | 独自 | ○ |
| bit | ○（ローカル） | △（fs sandbox） | ○（git notes の PR） | git 互換 | ○（notes） |
| E2B / Daytona 等 | × | ◎ | × | × | × |
| GitHub / GitLab | ◎ | ×（Actions は別） | ○ | git | ○ |

**読み方**: 「保存」と「レビュー」の両方を製品として持つのは forge 系（Entire / Upstream / GitHub）だけ。Artifacts / Coregit / Mesa は保存専用で、レビューは持たない。実行を持つ製品はレビューを持たない。

したがって hns の形は **「保存は買い、レビューは作る」** になる。レビューは hns の差別化（会話・Task・実行・証拠が既に同じ場所にある）なので、外部 forge に寄せると弱くなる。
## 2. 契約で切り離す

    [Workspace]  (C, J) と commit id。保存先を知らない。
         │  run が始まる: base = C
         ▼
    [Run]        runId, baseCommit, headCommit, sessionId, status, evidence[]
         │  終わる: head = C'、checkpoint を打つ
         ▼
    [Review]     base..head の差分 + 根拠 + 指摘 + 判断（DO/D1 のレコード）
         │  承認: base を head に進める（merge）
         ▼
    [Handoff]    git fetch <remote> <commit> + 短命 token（任意）

| 契約 | 必須フィールド | 保存先 | 誰が書くか |
| --- | --- | --- | --- |
| Workspace | workspaceId, C, J, seq, watermark | R2 / Artifacts / Forgejo | Workspace DO + マシン |
| Run | runId, workspaceId, baseCommit, headCommit, sessionId, status | Session DO / D1 索引 | Session DO |
| Review | runId, findings[], decisions[], gateResults[], summary | Workspace DO / D1 | Worker（UI の操作） |
| Handoff | remote, commit, token(TTL), expiresAt | 一時発行（保存しない） | Workspace DO |

**Review は git の外に置く**。git notes に入れるのは export 用で、正本は DO/D1。理由は、レビューの状態（未解決・承認・却下）は追記ではなく更新が多く、git の object に向かないため。

## 3. 独立した意思決定

### D1. C の保存先

- **問い**: checkpoint commit の object をどこに置くか。
- **候補**:

| 案 | 仕組み | 利点 | 欠点 |
| --- | --- | --- | --- |
| **A. R2 正本（現行）** | checkpoint を pack で R2。ack は R2 → DO | 実装済み。上限なし。object lock。安い | pack / restore / GC を自前。UI が C を直接読めない。git remote がない |
| **B. R2 正本 + Artifacts ミラー** | run 終わりに同じ commit を Artifacts にも push。review / handoff は Artifacts から | 正本を壊さず、UI 読み・git fetch・fork を先に取れる。本番計測ができる | 二重保存。push が1回増える。二系統の失敗 |
| **C. Artifacts 正本** | C を Artifacts の repo に置く。R2 は 32MiB 超と Journal 本文だけ | pack / GC / restore を削れる。git が参照実装 | 1GB / 32MiB / 64MiB。beta。push p95。ack の契約が未確認 |
| **D. Forgejo 正本** | 自前の Forgejo に C を置く | lock-in なし。上限は disk 次第。標準 Git | 運用（DB・backup・監視）、fork はコピー、PAT に TTL なし、Cloudflare 外のホストが要る |

（Mesa / Coregit は外部 API と early access、Coregit は docs が 402 のため shortlist しない。競合調査を参照。）

**スコア（hns の基準）**:

| 基準 | A. R2 | B. ミラー | C. Artifacts | D. Forgejo |
| --- | --- | --- | --- | --- |
| 標準 git で読める | × | ◎ | ◎ | ◎ |
| UI が C を直接読める | △（自前） | ◎ | ◎ | ○（Worker から git は不可） |
| 正本の耐久（ack） | ◎（実装済み） | ◎ | ○（契約未確認） | ○（自前運用） |
| 上限（1GB / 32MiB / 64MiB） | ◎ | ○ | × | ◎ |
| 単一ユーザーの価格 | ◎ | ◎ | ◎ | ○（運用込み） |
| 運用負荷 | ◎ | ○ | ◎ | × |
| Cloudflare との統合 | ◎ | ◎ | ◎ | × |
| 成熟度 | ◎ | ◎ | ○（beta） | ◎ |

**インパクト評価（B が買う体験）**:

| 体験 | B でどうなる | 代替 | 頻度・強さ |
| --- | --- | --- | --- |
| マシンがオフラインでもレビュー | binding で C を読む | マシンに繋ぐ / 自前の R2 読み | 稀〜中 |
| 手元のエディタへ持ち帰る | git fetch | patch export / マシンで clone | 中 |
| 別マシンへ引き渡す | git fetch | cloudflared 経由で restore | 中 |
| fork / 並列探索 | repo fork | なし | 将来 |
| backup / export | clone | R2 export | 弱 |
| restore 実装の削減 | **C のみ**（B では減らない） | — | — |

**コスト**: dual write と失敗処理、token と repo のライフサイクル、beta の上限変更、backup/export の二系統、テスト。**中〜高**。

- **決定（D106）**: **git remote が要件になった（ユーザー判断）**。オフライン review と remote を同時に取るなら **B（R2 正本 + Artifacts ミラー）** を採る。B は two-way door（R2 が正本、ミラーを止められる）。A' は Artifacts を採らない場合の fallback。bit fork / dgit は採らない（[bit fork 評価](cloudflare-git-vcs.md)、dgit は未完成・メンテ停止）。C は 1GB / 32MiB / ack の確認後。
- **段階（two-way door）**:
  1. **B（今）**: run 終わりに Artifacts へ push。dual-write だが、失敗しても R2 の checkpoint を壊さない（非同期・再送）。
  2. **B'（縮小）**: remote が on-demand で足りるなら「Publish to git」だけに落とす。
  3. **C（正本）**: restore / GC の自前コストが支配的、または 1GB / 32MiB / ack が問題にならないと確認できた時。
- **トリガー**: git remote の要件（now）、オフライン review（now）、持ち帰り、fork の製品化。
- **two-way door**: B はミラーを止めれば R2 に戻る。C は移行を伴うので計測後。
- **未確認**: push ack が durable か、fork が COW か、1GB 到達時の挙動、repo あたりの ops 課金。
- **決める時期**: B は今。C は計測後。

### D2. repo の粒度と保持

- **問い**: workspace ごとか、run ごとか、世代ごとか。何を残すか。
- **選択肢**: workspace = repo + run branch / repo per run / 世代 repo。
- **判断基準**: 履歴の連続性 / fork のしやすさ / 1GB 上限 / repo 課金 / GC の作りやすさ。
- **推奨**: いまは決めない。workspace = repo を既定として維持し、ref 名も現行のまま。1GB に近づく / 複数 repo / 保持の要件が出た時に、世代 repo か repo per run を選ぶ。
- **S3（32MiB 超）**: これも今は規約を作らない。checkpoint が 32MiB で失敗した時に R2 に逃がす（pointer）。決めるのは「黙って落とさない」ことだけ。
- **反転可能性**: 低い（移行が必要）。**D1 を決める前に決めない**。
- **決める時期**: トリガー（1GB 接近、32MiB 失敗、複数 repo）。

### D3. レビューの単位と画面

- **問い**: 何を1つのレビューとして見せるか。新しい単位（Trail / PR）を作るか。
- **選択肢**: (a) Task = 意図、Run = 変更、Review = 判断（既存の Project/Task を使う）、(b) Trail を新設、(c) PR 風のブランチ単位。
- **推奨**: (a)。hns には既に Task があり、Entire の Trail は「Task + 複数 Run + 根拠 + ゲート」に分解できる。新しい単位を増やすと Project/Task/Workflow と衝突する。
- **反転可能性**: 高い（表示層とレコードの追加）。
- **決める時期**: 今。レビュー体験の設計は保存と独立。

### D4. レビューの証拠

- **問い**: 人間が判断するために何を1画面に出すか。
- **選択肢**: diff のみ / diff + テスト + 未解決 / さらに AI レビューのスコア（Entire 型）/ セッションとコストまで。
- **推奨**: diff + テスト結果 + 未解決 + 実行コマンド + セッションリンク + コスト。**スコアは最初は出さない**（根拠のない点数は判断を歪める）。
- **反転可能性**: 高い（足すだけ）。
- **決める時期**: 今。

### D5. 承認とゲート

- **問い**: 誰が何を満たしたら「承認」か。既存の capability 承認とどう分けるか。
- **選択肢**: (a) レビュー承認を capability/policy の承認に相乗りさせる、(b) レビュー専用のゲートを作る、(c) 承認なし（記録だけ）。
- **推奨**: 記録はレビュー専用、UI のキューは capability 承認と共通化。ゲートは「人間の承認」「テスト成功」「未解決 0」「base が最新」の4つから選ぶ。
- **反転可能性**: 高い。
- **決める時期**: 0220/0229（capability・承認 UI）と並行。

### D6. 来歴・メタデータ

- **問い**: prompt・モデル・セッション・判断をどこに置くか。
- **選択肢**: DO/D1（現行）/ git notes / 外部（Supafork 型）/ 併用。
- **推奨**: 正本は DO/D1。git notes へは export（レビュー記録・run メタデータ）を任意で行う。notes は fork で運ばれない点に注意。
- **反転可能性**: 高い。
- **決める時期**: 今（export は後）。

### D7. 並列探索

- **問い**: 同じ依頼を N 案で走らせ、比較・採用するか。
- **選択肢**: (a) やらない、(b) workspace を分けて fork、(c) 1 workspace 内の候補 branch。
- **推奨**: まず (a)。レビュー面で「Run の比較」ができてから (b)。1 workspace の同時編集は INV-13 と衝突するので採らない。
- **反転可能性**: 中（UX と fork の実装）。
- **決める時期**: レビュー体験の PoC 後。

### D8. 引き渡し・復元

- **問い**: 人間・別マシンへどう渡すか。
- **候補**:

| 案 | 仕組み | 利点 | 欠点 |
| --- | --- | --- | --- |
| **A. R2 pack restore（現行）** | C の pack を展開し、J を再生 | 実装済み。D1 A と一致 | 自前 restore。UI はマシンが要る |
| **B. git fetch（Artifacts）** | git fetch <remote> <commit> → checkout → J 再生 | git が参照実装。restore が単純 | D1 B/C が前提。token の配布 |
| **C. ArtifactFS** | commit を FUSE で lazy mount | 大きい repo の初回が速い | FUSE 依存（macOS は macFUSE）。運用が重い |

- **推奨**: **A を今、B を D1 B と同時、C は大きい repo で必要になってから**。
- **token**: 短命・repo 単位・ログに出さない。UI に fetch コマンドを出す。
- **反転可能性**: 高い（経路の差し替え）。
- **決める時期**: A は今。B は D1 B の実装時。C は必要が出たとき。

### D9. バックアップ・課金・依存

- **問い**: どこまで Cloudflare / 新サービスに依存するか。
- **推奨**: 正本は Cloudflare（D047 の範囲）。export（全 repo clone）を常に可能にし、保存層はインターフェースで差し替え可能にする。課金は月次で監視。
- **反転可能性**: 中（データ移行）。
- **決める時期**: D1 と同時。

### D10. 実行層（マシン / sandbox）

- **問い**: 実行をどこで行うか。Cloudflare にワークロードを置くか。
- **候補**:

| 案 | 仕組み | 利点 | 欠点 |
| --- | --- | --- | --- |
| **A. マシン + bwrap（現行）** | cloudflared で制御、実行はユーザーのマシン | D047 と一致。データが手元。inbound 不要 | bwrap が無い環境。マシン依存。同時実行は lease で1台 |
| **B. マシン + Cloudflare Sandbox** | 実行の一部を CF Containers に | S3Mount で R2 をマウント。snapshot | **D047 と衝突**（Cloudflare でワークロードを実行しない）。Containers 不採用 |
| **C. マシン + 外部 sandbox（Coder / E2B）** | 実行を外部に逃がす | 隔离・スケール | 外部依存。データ所在地。認証。コスト |

- **判断基準**: 実行を自分のマシンに残すか / inbound を開けないか / bwrap が使えるか / untrusted なコードを隔離する必要があるか / データ所在地 / コスト。
- **決定（2026-11-17）**: **A を維持**。D047 の「実行は自分のマシン、Cloudflare は制御と状態だけ」を変えない。B は untrusted なコードの隔離が自前で難しくなったときの**例外**として再検討。C はチーム/マルチテナントの要件が出るまで採らない。
- **反転可能性**: 中（実行層の差し替えは大きい）。
- **決める時期**: 今（維持を決める）。B / C は必要が出たとき。

### D11. オフライン review の読み取り経路

- **問い**: マシンがオフラインでも review するために、C をどこから読むか。
- **候補**:

| 案 | 仕組み | オフライン review | git remote / handoff | 複雑化 | 成熟度 |
| --- | --- | --- | --- | --- | --- |
| **B. Artifacts ミラー（推奨）** | run 終わりに Artifacts へ push、binding で読む | ○ | ○ | 中〜高（dual write） | beta |
| **C. Artifacts 正本（計測後）** | C を Artifacts に移す | ○ | ○ | 高（移行・上限） | beta |
| **A'. R2 read path（fallback）** | manifest を R2 に書き、Worker が読む | ○ | ×（patch export） | 中（コードのみ） | hns 自身 |
| **D. dgit 埋め込み（不採用）** | RepoCell DO + R2 | ○ | ○ | 高 | v0.0.8、最終 2026-08、単独メンテ |
| **F. bit を fork / embed（今は不採用）** | MoonBit Git 実装。read-only spike は可 | ○ | ○ | 最高（G4/G5/G7 + adapter） | 実験的・G4/G5 未解決 |
| **E. 完成 forge（不採用）** | r2g2 / gitfor 等 | ○ | ○ | 最高（製品置換） | 若い |

- **決定（D106）**: **B を今、C を計測後、A' は Artifacts を採らない場合の fallback。D / F / E は採らない**。
- **B の採用条件**: push が checkpoint の ack を遅らせない（非同期・再送でよい）、dual write の失敗が R2 の checkpoint を壊さない、1GB / 32MiB で checkpoint が失敗しない、wrangler のローカルシミュレータでテストできる。
- **B'（縮小）**: remote が on-demand で足りるなら「Publish to git」だけ。B の前段に置いてもよい。
- **F を採らない理由（今）**: bit は Git 実装 + object store / WAL / WASM component を持ち、参照実装としては最良。ただし bit 自身の docs が「phases 0–2 implemented、3–7 not started、未リリース」とし、G4（pack を丸ごとメモリ）/ G5（sync traits）/ G7（per-repo auth）が残る。full backend は自作と MoonBit 保守を伴う one-way door。**read-only の Workers spike（log / tree / diff）は低優先で可**（[評価](cloudflare-git-vcs.md)）。
- **D を採らない理由**: 未完成（v0.0.8）で最終コミットが 2026-08。hns がサーバコードと upgrade を持つ。
- **反転可能性**: B は高い（ミラーを止める）。C は中（移行）。A' は高い。
- **決める時期**: B は今。C は 2〜4 週間の計測後。

### D11.1 git remote がない場合にできないこと

| 能力 | git remote あり | A'（remote なし） | 代替 |
| --- | --- | --- | --- |
| 外部の git から clone / fetch / push | ○ | × | bundle / patch export（一方向） |
| 人間のエディタで fetch / push | ○ | × | hns の UI で編集 / patch を当てる |
| 外部 CI が clone して build | ○ | × | hns の webhook で CI を起動 |
| GitHub などへのミラー / 公開 | ○ | × | bundle を書き出して手で push |
| 複数マシン間の git 同期 | ○ | × | hns の R2 + J restore |
| fork / merge を git の意味論で | ○ | × | hns の Trail / patch で代替 |
| submodule / LFS / shallow / partial clone | ○ | × | hns の R2 spill（LFS 相当） |
| tag / 任意 ref / signed push / hooks | ○ | × | hns のメタデータ |
| 標準 git による独立バックアップ（脱出） | ○ | × | R2 export / bundle |
| blame / 検索 / diff | ○ | ○（hns が実装） | Worker 側で計算 |
| machine 上の agent が local git を使う | ○ | ○ | そのまま |

**要点**: review と restore は remote なしで成立する。remote がないと困るのは **持ち帰り（双方向）・外部ツール連携・標準 git としての脱出経路**。したがって remote は「review の前提」ではなく、**製品価値（handoff / ecosystem / escape hatch）の判断**になる。


## 4. レビュー体験の深掘り

### 4.1 人間がやること（JTBD）

1. **5秒で把握**: 何がどれだけ変わったか（ファイル・行・binary・削除）。
2. **危険を見つける**: 意図と違う変更、消えた設定、秘密、大きすぎる変更。
3. **部分的に採用する**: このハンクは要る、これは要らない。
4. **修正を依頼する**: 指摘を次の Run の入力にする。
5. **承認して次へ**: base を進める（merge）/ checkpoint を確定する。
6. **後から辿る**: なぜこの変更になったか（session・prompt・判断）。

### 4.2 hns の既存原則との接続

- 原則5「完了後は、成果物と検証結果でレビューさせる」: diff・テスト・変更ファイル・未解決を1面に。過程の再生を主役にしない。
- 6段階モデルの「結果」: 差分優先の要約 / 確信度と未解決。
- 16パターン: ハンク単位の Keep / Undo / Apply、チェックポイントとロールバック、操作履歴と Undo。
- 既存の diff 実装（0009 / 0011）: 行 diff は patience + LCS、巨大区間は全削除+全追加に落とす。UI はハンク単位。**この実装をそのまま Run の base..head に使える**。

### 4.3 競合のレビュー体験

| 製品 | 単位 | 強み | 弱み | hns が採るか |
| --- | --- | --- | --- | --- |
| GitHub PR | branch | diff・コメント・承認・CI の標準 | agent のセッション・意図が外にある。repo を量産すると重い | 概念だけ |
| Entire Trails | intent + 複数 change | **意図を先に**、eval を push ごとに、直近5回の推移、session をリンク、Gates（human/findings/checks/up-to-date） | クラウドのレビュー agent 前提。 forge 依存 | **強く参考** |
| Upstream | Change Request | stack、必須承認、CODEOWNERS、merge queue、agent onboarding | alpha。 forge 依存 | 一部 |
| Cursor / Cowork | session / task | Review changes / Revise の2択、チェックポイント、差分要約 | 履歴・引き渡しは弱い | 既に原則に採用 |
| bit | repo ローカル | PR/issue を git notes に保存、relay で同期 | 実験的。UI はまだ | 参考（notes export） |
| hns（現状） | Conversation / Progress | 会話と実行が見える。diff 実装あり | **Run 単位のレビュー面が未設計** | ここを作る |

**Entire から借りる3つ**: (1) 意図（Task）を先に置く、(2) 変更の根拠（session・コマンド・テスト）を diff の隣に、(3) 反復の推移（attempt 1..N）を見せる。
**借りないもの**: クラウドで review agent を常時走らせる、スコアを既定で出す、multi-repo trail。

### 4.4 提案: Run Review Sheet

Task の中に Run の一覧、Run を開くとレビュー面。会話は右または下に残す（過程を主役にしない）。

    ┌ Task: 認証のリトライを直す ─────────────────────────────┐
    │ Run 3   needs review   12 files  +240 -80   2 tests failed │
    │ ─────────────────────────────────────────────────────── │
    │ [Summary] 何を変えたか（3行）                             │
    │ [Diff]    base 1a2b3c → head 4d5e6f   files / hunks       │
    │ [Evidence] tests, commands, duration, cost, session link  │
    │ [Open]    unresolved 2 / findings 1 (high)               │
    │ [Actions] Review changes | Ask agent to revise | Approve  │
    └─────────────────────────────────────────────────────────┘

- **base / head は commit**。作業ツリーの未確定変更（U）はレビュー対象にしない（INV-05 と一致）。
- **Diff は3層**: ファイル一覧（footprint）→ ハンク → 行。binary と巨大ファイルは「変更あり・プレビュー不可」と明示。
- **ハンク操作**: Keep / Undo / Apply は Workspace の版付き書き込みを通す（UI を正本にしない）。
- **Revise**: レビューの指摘を次の Run の入力にする。新しい Run は前の Run の head から始める。
- **Approve**: 判断を記録し、base を head に進める（merge）。merge の実体は checkpoint ref の更新。
- **Attempts**: Run 1..N を並べ、前回との差分と未解決の推移を出す。スコアではなく「テスト・未解決・変更量」で推移を見る。
- **Handoff**: レビュー面に git fetch コマンド（短命 token）を出す。押すとコピー。

### 4.5 データモデル（案）

    RunReview {
      runId, workspaceId, taskId,
      baseCommit, headCommit, sessionId,
      status: needs_review | changes_requested | approved | merged | discarded,
      summary, evidence[], findings[], decisions[], gateResults[]
    }
    Finding { id, severity: high | medium | low | none, file?, hunk?, source: agent | test | human, status: open | resolved | dismissed }
    Decision { actor, action: approve | request_changes, at, note }
    GateResult { gate: human_review | tests | findings | freshness, status, detail }

すべて commit id 参照。Review は git の外（DO/D1）。git notes へは export のみ。

### 4.6 保存層との独立性

- レビュー面が必要とするのは base / head の commit id と、その diff を読む能力だけ。
- R2 の object からでも、Artifacts の binding からでも、dgit の content API からでも読める。
- したがって **D1（保存先）を決める前に D3〜D5（レビュー）を作れる**。オフライン review は D11（A' の read path）で先に取れる。

### 4.7 初期にやらないこと

- 行コメントのスレッド解決、reviewer の複数割当、CODEOWNERS。
- クラウドの review agent 常時実行（将来、マシン上の read-only run としてなら可）。
- multi-repo の Trail、stacked changes、merge queue。
- スコア（confidence / risk）の表示。根拠が揃うまで出さない。

### 4.8 計測

- **time to first decision**: レビュー面を開いてから承認/差し戻しまで。
- **revise rate**: 差し戻しなく承認された Run の割合。
- **attempts per task**: 反復回数。
- **unresolved at merge**: 未解決を残して merge した件数（0 が目標）。
- **review-to-merge time**。

## 5. 決定の順序

| 順 | 決めること | 依存 | いつ |
| --- | --- | --- | --- |
| 1 | 契約（Run / Review / Handoff） | なし | 今週 |
| 2 | D3 レビューの単位、(D4 証拠)、(D5 ゲート) | 契約 | 今週 |
| 3 | D10 実行層（マシン + bwrap を維持） | なし | 決定済み |
| 4 | レビュー面の PoC（現行 R2 + diff 実装） | 1, 2 | 1〜2週間 |
| 5 | D1 B（Artifacts ミラー）の実装 | 1, 2 | 今 |
| 6 | D11 オフライン review（binding で C を読む） | B | B と同時 |
| 7 | D1 C（Artifacts 正本）の判断 | 計測 | 2〜4週間 |
| 8 | A'（R2 read path） | — | Artifacts を採らない場合の fallback |
| 9 | D2 repo 粒度・保持、S3 | D1 の上限 / 32MiB 失敗 | トリガー |
| 10 | D7 並列探索 | レビュー面の比較 | その後 |
| 11 | D9 export・課金監視 | D1 | D1 と同時 |

## 6. 次の2週間の PoC

1. **Run Review Sheet**: 既存の Run から base/head を出し、diff・テスト・未解決・セッションリンクを1画面に。保存層は触らない。
2. **Revise ループ**: 指摘 → 次の Run → attempt 比較。指摘が次の Run に入ることを確認。
3. **Approve ゲート**: 承認レコード + base 更新（merge）。capability 承認 UI とキューを共有できるかを見る。

成功条件: レビュー面を開いてから30秒以内に「承認 / 差し戻し」を決められる。未解決が0でない Run は承認できない。

## 7. 未決・リスク

- レビュー記録を DO に置くか D1 に置くか（更新頻度と一覧検索のバランス）。
- merge の意味（base ref を進めるだけか、checkpoint を打ち直すか）。
- ハンク単位の Apply と Workspace の版チェックの整合（部分適用の原子性）。
- 差し戻しの指摘を agent に渡す形式（自然文 / 構造化 finding）。
- 監査とレビューの関係（誰がいつ承認したかを audit に載せる）。

## 8. 参考

- hns: [interface.md](../docs/design/interface.md)（原則5・6段階・16パターン）、[review/ux.md](../docs/review/ux.md)、[0009](../work/issues/0009-diff-view.md) / [0011](../work/issues/0011-diff-limit.md)、[durability.md](../docs/durability.md)
- Entire Trails: https://docs.entire.com/guides/trails/overview / Gates: https://docs.entire.com/guides/trails/gates / Agents: https://docs.entire.com/guides/trails/agents
- Upstream: https://upstream.codes/ / docs: https://upstream.codes/docs
- GitHub PR: https://docs.github.com/en/pull-requests
- bit: https://github.com/bit-vcs/bit
