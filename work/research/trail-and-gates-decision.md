# Trail 採否とゲート厳しさの決定資料

2026-11-17 / 関連: [責務分解](review-experience-and-decisions.md) / [競合調査](cloudflare-artifacts-competitors.md)

## 0. この資料の答え

1. **Trail を新設しない根拠**は前回提示できていなかった。結論としては「新設しない」が依然妥当だが、**新設を選ぶ条件**も含めて材料を出す（§1〜§4）。
2. **ゲートの初期値**は「チームの四人眼」を真似すると単一ユーザーでは劇場になる。既製品の既定値と失敗モードを調べ、**証拠必須 + 明示承認 + リスク階層**を推奨する（§5〜§6）。
3. **意図中心（Trail）とそれ以外**の5案を、データモデル・UX・コスト・向く条件で並べる（§3）。

## 1. Trail とは何か（一次資料）

Entire の Trail は「PR の置き換え」と定義される。構成要素は次の通り。

| 要素 | 内容 |
| --- | --- |
| intent | title / description / type / assignees / priority。コードを書く前に作れる |
| changes | ブランチを change として複数リンク。commit / checkpoint / session をまとめる |
| sessions | agent のセッション（transcript・tool call・token）を change に紐づける |
| evidence | push ごとの eval（confidence / risk / security / drift など）と findings（high / medium / low） |
| gates | up-to-date / human review（最小承認数・作者の扱い・push でリセット）/ findings（severity 閾値）/ checks |
| merge | ゲートを満たしたときだけ merge。複数 repo にまたがれる |

### なぜ PR では足りないと Entire は言うか

> In a pull request (PR), developers post their comments in a linear timeline, and CI provides a status at the bottom followed by the merge button. Now coding and code review are spamming this timeline with long descriptions. ... The pull request has become an audit log that only the agent reads. It does not provide the information for the developer to decide whether they can merge with confidence.

つまり Trail が解くのは「diff が見えない」ことではなく、**diff の外にある判断材料（意図・反復・根拠・未解決）が時系列に散らばる**こと。

## 2. hns の既存単位との重なり

### 2.1 いまの型

| 単位 | フィールド | 役割 |
| --- | --- | --- |
| Project | id, name | 会話・Task・Workflow・Automation の所有者 |
| Conversation | id, project_id, title, created/updated, archived, deleted | 会話。Session DO の実行を含む |
| Task | id, project_id, title, status(todo/doing/done/blocked), timestamps | **軽いカンバン札**。説明・受け入れ条件・会話リンク・実行リンクが無い |
| Run | Session DO 側の実行単位（core の公開型ではない） | base から head までの変更 |
| Review（提案） | base/head, diff, evidence, findings, decisions, gates | まだ型が無い |

### 2.2 Trail の要素は hns のどこにあるか

| Trail の要素 | hns の対応 | 状態 |
| --- | --- | --- |
| intent | Task（title/status）+ Project | **説明・受け入れ条件・優先度が無い** |
| changes | Run + checkpoint commit（C） | ○（Run と Task が未リンク） |
| sessions | Conversation / Session DO | ○（Task と未リンク） |
| evidence | Progress イベント / Journal / diff 実装 | △（レビュー面が未設計） |
| eval / findings | なし | × |
| gates / approvals | capability の承認（効果の承認） | △（コード承認は別物） |
| multi-repo | なし（1 workspace） | × |
| merge | checkpoint ref / base 更新 | △（意味が未定義） |

**読み方**: Trail の8要素のうち、hns は5つを別々に持っている。足りないのは「intent の実体」「Task と Run/Conversation のリンク」「Review レコード」「ゲート」。新しい Trail を作ると、この5つを別単位でもう一度作ることになる。

## 3. 選択肢（意図中心とそれ以外）

### A. Trail を新設（意図中心）

- **モデル**: Trail { project_id, title, description, type, priority, status, changes[], review }。Task とは別。
- **UX**: サイドバーに Trails。Task ボードとは別の一覧。Trail 詳細に changes / sessions / evidence / gates。
- **利点**: 意図を先に置ける。複数 repo・複数 change・チーム割当にそのまま伸びる。Entire と同じ語彙。
- **欠点**: Task と二重になる（両方 status を持つ）。UI の入口が2つ。Project/Task/Workflow と語彙が衝突。移行と GraphQL/権限/テストが増える。
- **コスト**: L（新テーブル・型・API・画面・移行・テスト）。
- **向く条件**: 近い将来に複数 repo・複数人・外部 contributor が来る。Task をカンバン専用に保ちたい。
- **データモデル案**:
      Trail { id, project_id, title, description, type, priority, status }
      TrailChange { trail_id, workspace_id, base, head, run_id }
      TrailReview { trail_id, findings[], decisions[], gates[] }
  Task は残る。Trail と Task のどちらが仕事の単位かを UI で選ばせることになり、**二重の status 機械**ができる。

### B. Task を Trail に拡張（推奨候補）

- **モデル**: Task に description / acceptance / priority を追加。Conversation と Run に task_id（または link テーブル）。ReviewRecord を run に付ける。Task の status 語彙は変えない。
- **UX**: 既存の Task ボードがそのままレビュー待ちキューになる。Task 詳細に Run 一覧と Review 面。
- **利点**: 新しい単位を作らない。既存の Project/Task/Conversation と整合。実装が最小。Task が「意図の器」になる。
- **欠点**: Task が重くなる（説明・受け入れ条件・レビュー）。複数 repo は後で拡張が要る。
- **コスト**: M（列追加・リンク・ReviewRecord・Task 詳細 UI）。
- **向く条件**: 単一ユーザー・単一 workspace が当面の前提。語彙を増やしたくない。
- **データモデル案**:
      Task { id, project_id, title, description, acceptance, priority, status }
      TaskLink { task_id, conversation_id | run_id }
      ReviewRecord { run_id, base, head, status, findings[], decisions[], gates[] }
  新しいトップレベル単位は増えない。Task の status はカンバンのまま、レビュー状態は ReviewRecord に持つ。

### C. Conversation を意図にする

- **モデル**: Conversation が intent（title + 最初のメッセージ）。Run は Conversation の中。Review は Run に付く。Task はカンバン札のまま。
- **UX**: 主画面（Conversation/Progress）がそのままレビューの入口。Task ボードは補助。
- **利点**: 既存の主画面と一致。新単位ゼロ。会話の文脈がそのまま意図。
- **欠点**: 会話はタスクではない（複数会話・改名・分岐）。Task と会話が未リンクのまま。会話の無い Task を扱えない。
- **コスト**: S（リンクと Review のみ）。
- **向く条件**: 「会話が仕事の単位」と割り切る。Task ボードを主役にしない。

### D. Run 中心（Task は軽いまま）

- **モデル**: Run に意図スナップショット（prompt / plan / acceptance）を持たせ、Review は Run に付ける。Task は分類だけ。
- **UX**: Run 一覧がレビューキュー。Task はフィルタ。
- **利点**: 最小。agent の実行と1対1。複数 Run の比較が自然。
- **欠点**: 「この Task は何を達成すべきか」が Run ごとに散る。長期の意図が弱い。
- **コスト**: S。
- **向く条件**: 1回の実行で完結する仕事が多い。Task を管理したい欲が弱い。

### E. Change を独立させる

- **モデル**: Change { base, head, run_id, repo, review }。Task/Trail は Change を束ねる。
- **UX**: 変更単位でレビュー。1 Run に複数 Change（複数 repo）も可能。
- **利点**: git と1対1。将来の multi-repo・複数変更に強い。
- **欠点**: いまは Run = 1 workspace = 1 change なので、ほぼ冗長。単位が増える。
- **コスト**: M。
- **向く条件**: 複数 repo の変更を1つの意図にまとめる要件が近い。

### 比較表

| 案 | 新単位 | 意図の実体 | 複数 Run | multi-repo | コスト | 語彙の増加 | 推奨度 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A Trail 新設 | 1 | Trail | ○ | ○ | L | 大 | 条件付き |
| B Task 拡張 | 0 | Task | ○ | △ | M | なし | **高** |
| C Conversation | 0 | Conversation | ○ | × | S | なし | 中 |
| D Run 中心 | 0 | Run | ○ | × | S | なし | 中 |
| E Change 独立 | 1 | Task/Trail | ○ | ○ | M | 中 | 条件付き |

## 4. 判断材料: Trail を新設すべき条件

次のいずれかが**近い将来（3か月以内）に必要**なら A を選ぶ価値がある。

1. **multi-repo**: 1つの意図が複数 repo の変更を含む。
2. **複数人**: 割当・承認者・CODEOWNERS が要る（hns はチーム RBAC をやらないと決めている）。
3. **会話を伴わない仕事**: 外部から起票され、会話なしで agent に渡る。
4. **Task をカンバン専用に保つ**プロダクト判断（Task に説明やレビューを載せたくない）。
5. **Entire / Upstream との相互運用**で、Trail / Change Request を外部単位として扱う。

どれも当てはまらないなら、**B（Task 拡張）で Trail の意味を満たせる**。Trail という名前を UI で使うかは別問題で、モデルを増やさずに「意図 → 変更 → 根拠 → ゲート」を Task 詳細で見せられる。

**前回の「新設しない」は、この比較を省略していた**。判断するなら上の5条件のうち、どれがいつ必要かを決めればよい。

## 5. ゲートの徹底調査

### 5.1 製品別の既定値と体験

| 製品 | 既定 | 承認 | stale の扱い | findings / checks | bypass |
| --- | --- | --- | --- | --- | --- |
| GitHub | 保護なし（個人 repo） | 0〜10 人。code owners も指定可 | diff が変わったら承認を無効化（任意） | status checks、conversation resolution、merge queue | 管理者は bypass 可（設定で禁止可） |
| Reviewable | GitHub 連携 | 承認レベル（複数段階） | revision ごとにレビュー | 議論ごとの disposition と resolution | — |
| Ship / Show / Ask（Fowler） | 変更ごとに3レーン | レーンで決まる | — | — | — |
| GitLab | 承認ルールは Premium | 最小承認数、作者除外、code owners | push でリセットする設定（一次資料の該当箇所は未確認） | merge trains、パイプライン必須 | 管理者 |
| Gerrit | Code-Review + Verified | -2〜+2 の票。+2 と +1 が submit 条件の典型 | **sticky vote**（copyCondition で新しい patch set へ引き継ぐ） | submit requirements（ラベル・フッター・全 reviewer 承認など） | 権限で override |
| Entire | Gates はオフ | 最小承認数、作者の承認可否、push でリセット | push でリセット（設定） | findings は severity 閾値（既定 high、severity なしは常に block）、checks | 管理者が理由付きで bypass |
| Upstream | 承認は任意 | 必須承認、CODEOWNERS、merge queue | 未確認 | checks | 管理者 |
| Graphite | merge queue は任意 | PR の承認に従う | 未確認 | merge queue で main を守る | — |
| Google（参考） | 1 reviewer の LGTM | 1 人 | — | — | — |
| Cursor / Cowork | ゲートなし | Review changes / Revise の2択 | — | チェックポイント | — |
| AI レビュー（CodeRabbit 等） | advisory | コメント中心。block は任意 | — | findings | — |

### 5.2 優れた体験設計のパターン

1. **ゲートは変更の上に出す**（設定画面ではなく review 面に pass / pending / blocked を並べる）。Entire と GitHub の checks がこの形。
2. **なぜ止まっているかを1行で言う**（「承認が1つ足りない」「high の finding が2件」「base が古い」）。
3. **直す場所へ飛べる**（finding → 該当行、チェック → ログ、古い → rebase）。
4. **path / risk で厳しさを変える**（GitHub の code owners、ruleset の path 条件）。全部同じ強さで止めない。
5. **stale の扱いを選べる**（GitHub は diff 変更で承認無効、Gerrit は sticky vote、Entire は push でリセット）。agent は頻繁に push するので、ここが体験の分かれ目。
6. **bypass は理由付き + 監査**（Entire の bypass、GitHub の管理者 bypass）。
7. **承認疲れを設計で減らす**（バッチ承認、緑なら自動 merge、blocking だけ既定表示）。
8. **段階的に厳しくする**（最初から Gerrit の +2/+1 を真似ない。Google は 1 reviewer）。

### 5.3 失敗モード

- **approval fatigue**: 全部承認させると、中身を見ずに押す。→ risk 階層とバッチ。
- **rubber stamping**: 単一ユーザーで「作者 ≠ 承認者」を装うと形骸化する。→ 四人眼ではなく「明示的な受け入れ」と「証拠」で守る。
- **flaky checks**: 必須チェックが不安定だと bypass が常態化。→ 失敗理由と再実行、bypass の監査。
- **stale approvals**: 承認後に agent が push すると、承認した diff と違うものが merge される。→ head commit に承認を紐づける。
- **gate sprawl**: ゲートが増えて誰も理由を説明できない。→ 初期は4つまで。

### 5.4 変更ごとの厳しさ（Ship / Show / Ask）

Rouan Wilsenach（Martin Fowler のサイト）の3レーン。

| レーン | 意味 | 向く変更 |
| --- | --- | --- |
| Ship | レビューなしで mainline に merge | 低リスク、設定、ドキュメント、使い捨て |
| Show | 先に merge し、PR を開いて後からレビュー | 中リスク。止めずに透明性だけ確保 |
| Ask | レビューが終わるまで merge しない | 高リスク、共有 base、不可逆 |

**なぜ重要か**: ゲートを全体設定にすると「全部 Ask」か「全部 Ship」になり、承認疲れか無統制のどちらかに振れる。3レーンなら**変更ごとに重さを選べる**。hns は run / task ごとの mode として持てる。

### 5.5 ゲート UX のチェックリスト

1. ゲートの状態が**変更の画面**に出る（設定画面に隠れない）。
2. 止まっている理由が1行で、**直す場所へ飛べる**。
3. 既定では **blocking だけ**を出し、advisory は畳む。
4. **path / risk で厳しさを変える**（秘密・migration・deploy は Ask）。
5. 承認が**どの commit に対するものか**を表示し、head が変わったら無効化を選べる。
6. **bypass は理由必須 + 監査**。常用されたらゲート設計を見直す。
7. **バッチ承認**（同種の low-risk をまとめる）。
8. **変更ごとの mode**（Ship / Show / Ask）を持つ。
9. 単一ユーザーで**四人眼を装わない**（「作者 ≠ 承認者」を必須にしない）。
10. time to decision / revise rate / bypass rate を測る。

## 6. hns の初期ゲート（推奨）

### 6.1 前提: 単一ユーザーでは四人眼を作らない

hns の最初の利用者は1人。GitHub / GitLab / Gerrit の「承認者数」はチームの統制であり、そのまま持ってくると**自分で自分の変更を承認する劇場**になる。代わりに、次の3つで守る。

1. **証拠**: 完了には diff・実行したコマンド・テスト結果・未解決リストを必須にする（原則5）。
2. **明示的な受け入れ**: merge は明示操作。既定で自動 merge しない。
3. **リスク階層**: 危険な変更だけ追加の確認を要求する。

### 6.2 リスク階層

| Tier | 例 | 必須ゲート |
| --- | --- | --- |
| T0 分析・読み取り | 調査、説明、read-only | 証拠は任意。承認不要 |
| T1 通常の編集 | ソース変更、テスト追加 | 証拠 + （あれば）テスト + high findings 0。merge は明示承認 |
| T2 危険な変更 | 削除、秘密、ネットワーク、deploy、大量変更（例: 50 files / 1,000 lines 超） | T1 + 明示確認（対象パスを表示） |
| T3 共有 base への merge | main / 共有ブランチ | T1 + freshness（conflict なし）+ checks |

### 6.2.1 run / task ごとの mode

| mode | hns での意味 | 既定の適用先 |
| --- | --- | --- |
| Ship | checkpoint を承認なしで確定 | T0（読み取り・調査）、使い捨ての候補 |
| Show | 先に確定し、レビューを後追い | T1 の workspace 内 checkpoint（base を進めない） |
| Ask | 承認まで base を進めない | T1 の base merge、T2、T3 |

既定は **Ask**。ユーザーが Task / Run 単位で Show / Ship に落とせる（昇格は明示操作のみ）。

### 6.3 初期デフォルト（Phase 1）

- **G1 証拠必須**: diff・コマンド・テスト（あれば）・未解決。無い完了は unverified と表示。
- **G2 high findings は block**: レビュー agent / テスト / 人間の finding のうち high と severity なし。medium / low は advisory。
- **G3 merge は明示承認**: 承認者は owner 1 人。承認は head commit に紐づけ、**head が変わったら承認を無効**（既定）。
- **G4 checks は任意**: プロジェクトにテストコマンドがある場合だけ必須。無い場合は advisory。
- **G5 freshness は conflict のみ**: 単一 writer なので通常は自動 rebase。conflict があるときだけ block。

### 6.4 段階導入

| Phase | 追加 | いつ |
| --- | --- | --- |
| 1 | G1 + G3（証拠 + merge 承認） | 今 |
| 2 | G4（テスト必須） | テストコマンドが安定してから |
| 3 | G2（high findings） | レビュー agent を入れてから |
| 4 | T2 の path 別ゲート（秘密・migration・deploy） | 事故か需要が出たら |
| 5 | 低リスクの auto-approve（opt-in） | 承認疲れが見えたら |

### 6.5 設定項目（最小）

- 必須承認数（既定 1、0 も可）
- 承認のリセット条件（head 変更でリセット / 差分が承認範囲の部分集合なら維持）
- findings の閾値（既定 high）
- 必須チェック名（既定: プロジェクトの test）
- bypass できる人（既定: owner）と理由の必須

### 6.6 計測

- time to decision / revise rate / bypass rate / unresolved at merge / gate の false block
- 承認後の push で承認が無効になった回数（stale の頻度）

## 7. 決めること

1. **Trail**: A（新設）か B（Task 拡張）か。判断は §4 の5条件のどれがいつ必要か。
2. **厳しさの持ち方**: 全体設定か、run / task ごとの Ship / Show / Ask か。
3. **ゲート初期値**: G1 + G3 で始めるか。テスト必須を Phase 1 からにするか。
4. **stale の既定**: head 変更で承認を無効にするか、差分が部分集合なら維持するか。
5. **bypass**: owner の理由付き bypass を許すか。

## 8. 参考

- Entire Trails: https://docs.entire.com/guides/trails/overview / Gates: https://docs.entire.com/guides/trails/gates / Agents: https://docs.entire.com/guides/trails/agents / 発表: https://entire.com/blog/the-git-forge-for-agent-human-collaboration
- GitHub: 保護ブランチ https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches / rulesets https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets / merge queue
- GitLab: 承認ルール https://docs.gitlab.com/user/project/merge_requests/approvals/rules/ / settings https://docs.gitlab.com/user/project/merge_requests/approvals/settings/
- Gerrit: labels https://gerrit-review.googlesource.com/Documentation/config-labels.html / submit requirements https://gerrit-review.googlesource.com/Documentation/config-submit-requirements.html
- Upstream: https://upstream.codes/pricing（必須承認・CODEOWNERS・merge queue）
- Graphite: merge queue https://graphite.com/docs/get-started-merge-queue
- Google eng-practices: https://google.github.io/eng-practices/review/reviewer/
- Ship / Show / Ask: https://martinfowler.com/articles/ship-show-ask.html
- Reviewable: https://docs.reviewable.io/（承認レベル・disposition・publish on push）
- hns: packages/core/src/types.ts / docs/design/interface.md / [責務分解](review-experience-and-decisions.md)
