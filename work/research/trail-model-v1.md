# Trail モデル v1: Task 置換と拡張可能な添付

2026-11-17 / 前提: [Trail 採否とゲート](trail-and-gates-decision.md) の回答（multi-repo・複数人・会話なしは将来高、カンバン不要、相互運用なし）

## 0. 回答を受けた結論

- 5条件のうち **multi-repo・複数人・会話なしの3つが「将来高い」**なら、Trail を新設する価値がある。
- **カンバンが不要**なので、Task と Trail を併存させない。**Trail が Task を置き換える**（TaskStatus とボードを廃止）。
- **相互運用しない**ので、Entire の API に合わせる必要はない。モデルだけ参考にし、hns の型・GraphQL・移行の作法に合わせる。
- 強化の方向は「Trail を意図のアンカーにし、**変更・セッション・証拠・プロダクト FB・メトリクスを後から attach** できるようにする」。

**一言**: Task を捨て、Trail を主単位にする。Trail は会話に依存せず、Change を複数持ち、後から信号（feedback / metric / eval）を足せる。

## 0.1 決定（2026-11-17）

- Q1 session: **B**（既定 summary、全文は R2 + reveal 監査 + TTL 30 日、repo に入れない）
- Q2 metric: **B**（相関 + 実験紐づけ。metric はゲートにしない）
- Q3 observing: **A**（14 日固定 + 手動 reopen。自動は Phase 2 opt-in）
- Q4 保持: **A**（TTL クラス + tombstone。プロジェクト別は Phase 2）
- Q5 複数人: **いま A、ターゲット B**（owner-only → プロジェクト役割 + 承認ポリシー。フル RBAC / SSO はやらない）

## 1. モデル

### 1.1 単位

| 単位 | 役割 | 主なフィールド |
| --- | --- | --- |
| **Trail** | 意図のアンカー。仕事の単位 | id, project_id, title, description, acceptance, kind, state, priority, created_by, created_at, updated_at |
| **Change** | 1つの変更（base..head）。Run と 1:1、将来は複数 repo | id, trail_id, workspace_id, repo_id?, base_commit, head_commit, run_id, state |
| **SessionLink** | Trail と会話・セッションのリンク（0..n） | trail_id, conversation_id?, session_id, run_id? |
| **Decision** | 承認・差し戻し・却下の記録 | trail_id, change_id?, actor, action, at, note, head_commit |
| **Finding** | レビュー・テスト・agent の指摘 | id, trail_id, change_id?, severity, source, status, file?, hunk?, summary |
| **GateResult** | ゲートの評価結果 | trail_id, change_id?, gate, status, evaluated_at, detail |
| **Attachment** | 後から足せる信号（§2） | feedback / metric / eval / note |

### 1.2 状態

    draft ──▶ active ──▶ in_review ──▶ merged ──▶ observing ──▶ closed
      │          ▲            │                                   │
      │          └────────────┘（差し戻し）                        │
      └──────────────────────────────▶ abandoned ◀────────────────┘（破棄）

| 状態 | 意味 | カンバンとの違い |
| --- | --- | --- |
| draft | 意図だけ。変更はまだ無い | 列ではない |
| active | 変更を作っている | — |
| in_review | 変更が判断待ち | 「Needs you」に出る |
| merged | base に取り込んだ | 完了ではない |
| observing | リリース後の信号を集めている | **変更追従のための状態** |
| closed | 追跡を終えた | — |
| abandoned | 捨てた | — |

**blocked は状態にしない**。止まっている理由は GateResult / Decision に出す（カンバンの列に戻さない）。

### 1.3 不変条件

- T-1: Trail は1つの Project に属する。ボードの列（todo/doing/done）を持たない。
- T-2: Change は1つの Trail に属し、base と head の commit を持つ。head = base は許さない。
- T-3: Session は 0..n。会話の無い Trail を許す（dispatch された仕事）。
- T-4: Attachment は追記専用。訂正は supersedes で新しい行を足す。occurred_at ≤ recorded_at。
- T-5: Decision は追記専用。承認は head commit に紐づき、head が変わると無効（設定で部分集合なら維持）。
- T-6: merged / closed でも Change と Attachment は残す。削除は Project の cascade のみ。
- T-7: 状態遷移は core の1箇所（trail の遷移表）に置き、switch は網羅する。

## 2. 添付（attach）の設計

### 2.1 種類を閉じる

| kind | いつ使うか | 主なフィールド |
| --- | --- | --- |
| feedback | ユーザーの声・インタビュー・サポート | channel, summary, sentiment, source_url, occurred_at |
| metric | プロダクト指標・監視値 | name, value, unit, window_start, window_end, source, occurred_at |
| eval | テスト・lint・レビュー agent の判定 | change_id?, name, status(pass/fail/error), detail, occurred_at |
| note | 判断の補足・議事録 | body(markdown), author, occurred_at |

**1つの JSON 列に詰めない**。kind ごとにテーブルと型を持ち、GraphQL では別リストにする。理由は、検証・クエリ・進化が効くから（hns の「型が正本」「保存形は store の外に出さない」に合わせる）。

### 2.2 後から attach できるための約束

1. **occurred_at と recorded_at を分ける**（いつ起きたか / いつ紐づけたか）。
2. **provenance を持つ**: source（in_app / email / support / ci / manual）、actor（user / agent / service）、external_id（冪等キー）。
3. **追記専用**: 更新しない。訂正は supersedes_id で新しい行。
4. **change か commit に紐づけられる**（任意）。どの変更の結果かを後から辿れる。
5. **closed の Trail にも attach できる**。負の信号は observing / active への再開の判断材料にする（自動再開は Phase 2）。

### 2.3 例

    Trail: 認証のリトライを直す（observing）
      Change 1: base 1a2b → head 4d5e（run 3）  merged
      Feedback: 「409 がまだ出る」（support, negative, 2026-11-18）
      Metric: auth_error_rate 1.2% → 0.4%（7日窓, 2026-11-25）
      Eval: e2e/auth pass（ci, 2026-11-17）
      Note: 再現手順（user, 2026-11-19）

この形で「意図 → 変更 → 証拠 → プロダクトの結果」が1本につながる。

### 2.4 Findings は別に持つ

指摘（finding）は添付ではなくレビューの状態を持つレコードにする。severity（high / medium / low / none）、source（agent / test / human）、status（open / resolved / dismissed）、file / hunk、summary。解決・却下は追記で記録し、high と severity なしはゲートで block（Entire の既定に倣う）。

### 2.5 UI

Trail 詳細を1画面にし、上から Intent / Changes / Sessions / Evidence / Signals / Decisions の順に置く。Needs you には in_review と、observing で負の信号が付いた Trail を出す。**カンバンの列は作らない**。

## 3. 変更追従（change following）

- Change は base..head の commit を持つ。diff は保存せず、commit から都度出す（既存 0009/0011 を使う）。
- Change に repo_id を持たせる（今は null 可）。将来 multi-repo になっても Trail は変えずに Change を増やす。
- リリース後の feedback / metric は Trail に attach し、change_id / commit に紐づける。
- 回帰が出たら **observing → active** に戻し、新しい Change を足す。Trail は閉じない。
- 「どの変更が原因か」は commit の時刻と metric の窓で絞る。bisect は Phase 3。

## 4. multi-repo / 複数人 / 会話なしの seam

| 将来の要件 | 今入れておくもの | 今作らないもの |
| --- | --- | --- |
| multi-repo | Change.repo_id（nullable） | repo 管理 UI、repo 横断のレビュー |
| 複数人 | created_by, actor_id, actor_kind（user/agent/service） | RBAC、招待、承認者割当 |
| 会話なし | SessionLink を 0..n。Trail は Conversation に依存しない | 外部起票の受け口 |
| 外部連携 | external_id, source | API トークン、Webhook |

## 5. ゲート

- ゲートは **Trail / Change 単位**。既定は Ask（§決定資料）。
- gate の種類は閉じる: human_review / tests / findings / freshness。metric_regression / feedback_required は Phase 2 で追加。
- GateResult は commit と evaluated_at を持ち、head が変わったら再評価する。
- 単一ユーザーでは「作者 ≠ 承認者」を必須にしない。証拠 + 明示承認 + リスク階層（T0〜T3）。

## 6. スキーマ案

### 6.1 SQL（store、0004）

    trails(id TEXT PK, project_id TEXT FK, title TEXT, description TEXT, acceptance TEXT,
           kind TEXT, state TEXT, priority TEXT, created_by TEXT,
           created_at TEXT, updated_at TEXT)
    trail_changes(id TEXT PK, trail_id TEXT FK, workspace_id TEXT, repo_id TEXT NULL,
                  base_commit TEXT, head_commit TEXT, run_id TEXT, state TEXT,
                  created_at TEXT, updated_at TEXT)
    trail_sessions(id TEXT PK, trail_id TEXT FK, conversation_id TEXT NULL,
                   session_id TEXT, run_id TEXT NULL, linked_at TEXT)
    trail_feedback(id TEXT PK, trail_id TEXT FK, change_id TEXT NULL, channel TEXT,
                   summary TEXT, sentiment TEXT, source_url TEXT NULL,
                   source TEXT, actor TEXT, external_id TEXT NULL,
                   occurred_at TEXT, recorded_at TEXT, supersedes_id TEXT NULL)
    trail_metrics(id TEXT PK, trail_id TEXT FK, change_id TEXT NULL, name TEXT, value REAL,
                  unit TEXT, window_start TEXT, window_end TEXT, source TEXT,
                  external_id TEXT NULL, occurred_at TEXT, recorded_at TEXT)
    trail_evals(id TEXT PK, trail_id TEXT FK, change_id TEXT NULL, name TEXT, status TEXT,
                detail TEXT NULL, source TEXT, occurred_at TEXT, recorded_at TEXT)
    trail_notes(id TEXT PK, trail_id TEXT FK, body TEXT, author TEXT, occurred_at TEXT, recorded_at TEXT)
    trail_decisions(id TEXT PK, trail_id TEXT FK, change_id TEXT NULL, actor TEXT, action TEXT,
                    head_commit TEXT NULL, note TEXT, at TEXT)
    trail_findings(id TEXT PK, trail_id TEXT FK, change_id TEXT NULL, severity TEXT,
                   source TEXT, status TEXT, file TEXT NULL, hunk TEXT NULL, summary TEXT,
                   created_at TEXT, resolved_at TEXT NULL, resolved_by TEXT NULL)
    trail_gates(id TEXT PK, trail_id TEXT FK, change_id TEXT NULL, gate TEXT, status TEXT,
                detail TEXT NULL, evaluated_at TEXT)

index: (project_id, state, updated_at) / (trail_id, recorded_at) / (trail_id, name, window_end)。

### 6.2 GraphQL

    type Trail { id, projectId, title, description, acceptance, kind, state, priority,
                 createdBy, createdAt, updatedAt,
                 changes: [TrailChange!]!, sessions: [TrailSession!]!,
                 feedback: [TrailFeedback!]!, metrics: [TrailMetric!]!,
                 evals: [TrailEval!]!, notes: [TrailNote!]!,
                 findings: [TrailFinding!]!,
                 decisions: [TrailDecision!]!, gates: [TrailGate!]! }
    type TrailChange { id, trailId, workspaceId, repoId, baseCommit, headCommit, runId, state }
    type TrailFeedback { id, channel, summary, sentiment, sourceUrl, source, actor,
                         occurredAt, recordedAt }
    type TrailMetric { id, name, value, unit, windowStart, windowEnd, source, occurredAt }

    Mutation: createTrail, updateTrail, addTrailChange, linkTrailSession,
              attachTrailFeedback, recordTrailMetric, addTrailEval, addTrailNote,
              decideTrail, evaluateTrailGates

列挙は閉じる: TrailState, TrailKind, TrailPriority, FeedbackSentiment, EvalStatus, FindingSeverity, GateKind, GateStatus。
注意: いまの entity generator がリスト/union を扱えない場合、先に spec を拡張する（Trail.changes などのリストは必須）。
**timeline は保存しない**。各リストを recorded_at / occurred_at で並べて UI が合成する（最初はクライアント、必要なら resolver で接続）。

### 6.3 型と検証

- core: 先に `Trail`, `TrailChange`, `TrailState` などを `types.ts` に足す。列挙は const 配列 + 派生 union。
- store: `TrailRowSchema` などを valibot で書き、`parseTrail` で公開型に。保存形は store の外に出さない。
- 遷移: `core/trail.ts` に遷移表を置き、`switch` は全状態 + never。
- GraphQL: `entities.ts` に Trail 系を追加。SDL は生成、手で書かない。

## 7. Task → Trail の移行

1. **0004**: 上のテーブルを作る。`tasks` から backfill（todo→draft, doing→active, done→merged, blocked→active + note）。
2. **schema version を上げる**。古い build は新しい DB を開かない（INV-12 の fail closed）。
3. **GraphQL**: `Task` / `TaskStatus` を削除し `Trail` を追加。Relay の生成物を更新。
4. **Web**: Sidebar の Task 一覧を Trail 一覧（Needs you / Active / Observing / Closed）へ。カンバン列は作らない。
5. **Automation**: `AutomationAction` の `task` を `trail` に（型・実行・テスト）。
6. **tasks テーブル**: 読み取りを止めて残す。drop は INV-12（加算のみ）の見直し後に別途決める。
7. **issue**: 0016（Project と Task）を Trail 前提に更新。新しい決定を docs/decisions.md に追記。

破壊的変更だが、いまは製品コードが core/store 中心で、Task の利用は GraphQL と Sidebar に限られる。**同一波で置き換える**のが最も安い。

## 8. MVP と後回し

| Phase | 入れる | 後回し |
| --- | --- | --- |
| 1 | Trail + Change + SessionLink、Note/Feedback/Eval の attach、Decision、既存 diff のレビュー面 | Metric、observing の自動再開、multi-repo UI |
| 2 | Metric attach、observing / active の再開、metric ゲート | 外部取り込み API、bisect |
| 3 | multi-repo の表示、assignee、外部 ingestion | RBAC、招待、監査の拡張 |

Phase 1 の受け入れ: Trail を作る → Change を足す → レビュー → 承認 → merged → feedback を attach → 詳細で1本の履歴に見える。

## 9. 決めること

1. **名前**: Trail か Work / Intent か（API と UI の語彙）。
2. **状態**: draft / active / in_review / merged / observing / closed / abandoned で良いか。
3. **MVP の添付**: feedback / metric / eval / note の4つで良いか（metric を Phase 2 に落とすか）。
4. **Task 廃止**: 同一波で置き換えるか、Task を残して Trail を並べるか（推奨: 同一波）。
5. **metric の取り込み**: 最初は GraphQL の手動 attach のみか、REST の外部取り込みを同時に作るか。

## 10. 参考

- [Trail 採否とゲート](trail-and-gates-decision.md) / [責務分解](review-experience-and-decisions.md)
- Entire Trails: https://docs.entire.com/guides/trails/overview / Gates: https://docs.entire.com/guides/trails/gates
- hns: packages/core/src/types.ts / packages/core/src/graphql/entities.ts / packages/store/src/migrate.ts / docs/design/interface.md
