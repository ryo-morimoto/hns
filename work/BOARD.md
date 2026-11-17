# Board

残作業の索引。1 issue = 1ファイル（`work/issues/`）。形式は [README.md](README.md)。

## 優先度マトリクス（重要度 × 緊急度）

| 象限 | 重要度 | 緊急度 | priority | 意味 | 件数 |
| --- | --- | --- | --- | --- | --- |
| Q1 | 高 | 高 | `now` | いまの波。依存が満たされている | 3 |
| Q2 | 高 | 低 | `next` | 重要だが、いまの波の後 | 69 |
| Q3 | 低 | 中 | `later` | 安い。隣接するときだけ | 5 |
| Q4 | — | — | `parked` | いまはやらない | 8 |

### 設計の合意（design）

| design | 件数 | 意味 |
| --- | --- | --- |
| `agreed` | 42 | 合意済み（`now` の必要条件）。根拠は issue の `design-ref` |
| `pending` | 43 | 設計待ち。設計レビューで `agreed` にする |

### 着手の規則

- **agent が着手してよいのは `priority: now` だけ。** `now` が空なら止まって人に聞く。
- `next` を `now` に上げるのは人の判断。レーン順（[D049 のレーン](#d049-のレーン並列の単位)）で上げる。agent が自分で昇格しない。
- `later` は `now` / `next` の作業に隣接するときだけ（同じファイル・同じレーン）。単独で着手しない。
- `parked` はユーザーが明示したときだけ。着手するなら先に `next` へ上げる。
- 優先度を変えるときは、issue の `priority:` とこの表を同時に直す。
- `now` は `design: agreed` かつ `depends-on` 充足のときだけ（[README](README.md) の「設計の合意」）。`design: pending` は設計レビューを先に通す。

### now（3）

| # | 作業 | 依存の状態 | 設計レーン |
| --- | --- | --- | --- |
| [0220](issues/0220-capability-contract.md) | capability 契約（canonical call・grant・policy 型） | 依存なし | L0（capability） |
| [0227](issues/0227-sandbox-hardening-spike.md) | sandbox 追加硬化の実測（Landlock / netns+proxy / seccomp） | 依存なし | L4（sandbox） |
| [0127](issues/0127-model-project-workspace.md) | Project と Workspace root の関連 | 0198 / 0159 done | L2（会話）/ L10（GraphQL） |

第2波は 0059 / 0153 / 0169 / 0163 / 0154 / 0157 / 0162 が done（c55fc2d / 37f5f1d / 1ab43ea / 176310e / 13556fd / 21c65b2 / 8355d1f）、0198 も done（bd33178）。いまの `now` は **0220 / 0227 / 0127**。0048 / 0049 / 0103 / 0149 / 0152 / 0160 / 0165 / 0181 / 0182 / 0191 / 0194 / 0199 は順番待ち。
0147 は 0194 / 0148 / 0165 を、0159 は 0160 / 0105 を、0151 の後は 0152、0190 の後は 0191 を開ける。0169 / 0157 / 0154 / 0162 / 0163 / 0198 は done。

### 次の昇格

`now` の条件は `design: agreed` かつ `depends-on` 充足。lead がレーン順に選ぶ（agent は昇格しない）。

- 順番待ち（0048 / 0049 / 0103 / 0149 / 0152 / 0160 / 0165 / 0181 / 0182 / 0191 / 0194 / 0199）は、枠が空いたら `now` へ。
- 設計待ちは 0 件。次の実装レーンは順番待ちから選ぶ。
- 依存待ちの agreed 6 件（0122, 0127, 0155, 0166, 0167, 0168）は、依存が解けたら `now` の候補。




### next（64）

`now` の条件は `design: agreed` かつ `depends-on` 充足。`next` は `now` ではない理由で分ける（設計待ち / 順番待ち / 依存待ち）。

- **設計待ち（design: pending・依存充足、0）**: なし
- **順番待ち（design: agreed・依存充足、13）**: 0043, 0048, 0049, 0103, 0149, 0152, 0160, 0165, 0181, 0182, 0191, 0194, 0199
- **依存待ち（51、* は design: agreed）**:
  - **L4 耐久**: 0125*, 0155*, 0167*, 0168*
  - **L3 マシン**: 0148*
  - **L6 認証**: 0158
  - **L8 運用**: 0161, 0164, 0166*
  - **L9 ゲートウェイ**: 0122*
  - **基盤・移植**: 0038*, 0040, 0069, 0070, 0071
  - **code mode（新規・設計待ち）**: 0200, 0201, 0202, 0203, 0214, 0215, 0216
  - **capability / policy（新規）**: 0221〜0226, 0228, 0229
  - **UI 画面**: 0104, 0105, 0106*, 0107, 0108, 0109, 0110, 0111, 0112, 0113, 0114
  - **API / data**: 0116, 0117, 0123, 0124, 0126, 0128, 0129, 0130, 0131, 0197

### D091 ツール呼び出し（capability）

契約は [docs/capability.md](../docs/capability.md)、決定は D091。Phase 0 は 0220 → 0221 → 0222、Phase 1 は 0220 → 0223 / 0225 → 0224 → 0226（0224 は 0148、0225 は 0148 / 0194 も待つ）。0228 / 0229 は 0198 / 0160 の後。0220 / 0227 は 2026-11-17 に `now` へ（依存なし）。

- 0220 の後に 0221 / 0223 / 0225 を並列。0222 は 0221 の後、0224 は 0223 の後。0226 は収束点。0227 はいつでも並列（製品コードを変えない）。
- **共有ファイル**: `packages/agent/src/tools.ts` は 0221 / 0226、`packages/server/src/do/session.ts` は 0203（code mode session）/ 0222 / 0224 / 0226 と共有。同時に流さない。先に着地した側に合わせ、後続が rebase する。
- 承認面（0228 / 0229）は 0198（Mutation）と 0160（UI 配信）を待つ。0223 のサービスは先にテストできる。

### later（5）

| # | 何 | なぜ今でないか |
| --- | --- | --- |
| 0041 | CI | gate と hooks で当面足りる |
| 0120 | Review evidence | 記録の自動化 |
| 0173 | docs の残り | 0140 の取りこぼし |
| 0192 | findings 13 件の再判定 | 0146 の統合後。指摘の棚卸し |
| 0193 | backlog メタデータの整合 | 0141 / 0146 の統合後。docs だけ |

### parked（8）

| # | 何 | なぜ今やらないか |
| --- | --- | --- |
| 0010 | WASM エディタ | Want |
| 0044 | マルチマシン | ユーザーが保留 |
| 0055 | Journal の保存をまとめる | 0169 の redesign で置き換わる |
| 0061 | JournalIntent.temp の型 | 0156 / 0169 で型ごと作り直す |
| 0065 | store の low 残件 | 見た目 |
| 0115 | overview API | 0149 の後に形を決める |
| 0119 | 会話の単体取得 | 0146 が持つ |
| 0121 | 検索・pagination | 0149 が持つ |



| # | 作業 | 状態 | 優先度 | 依存 |
| --- | --- | --- | --- | --- |
| [0001](issues/0001-t02-remainder.md) | T-02 の残り | **done** | — | — |
| [0002](issues/0002-mutation-crash.md) | T-03/T-04 Mutation の故障注入 | **done** | — | 0001 |
| [0003](issues/0003-walking-skeleton.md) | Workspace Walking Skeleton | **done** | — | 0002 |
| [0004](issues/0004-dev-env.md) | 開発環境の固定 | **done** | — | — |
| [0005](issues/0005-toctou.md) | TOCTOU の窓を閉じる | **done** | — | — |
| [0006](issues/0006-sandbox-deploy.md) | sandbox の前提を固める | **done** | — | — |
| [0007](issues/0007-conversation.md) | 会話の実結線 | **done** | — | — |
| [0008](issues/0008-editor.md) | Editor の最小 | **done** | — | — |
| [0009](issues/0009-diff-view.md) | diff の表示 | **done** | — | 0008 |
| [0010](issues/0010-wasm-editor.md) | WASM エディタ（Want） | **保留** | parked | — |
| [0011](issues/0011-diff-limit.md) | diff の上限撤廃 | **done** | — | 0009 |
| [0012](issues/0012-real-provider.md) | 実 Provider（Ollama Cloud） | **done** | — | — |
| [0013](issues/0013-opencode-go.md) | 2プロバイダ目（OpenCode Go）と API 方式の比較 | **done** | — | 0012 |
| [0014](issues/0014-integrated-mvp.md) | 統合 MVP（1マシン） | **done** | — | 0003, 0008, 0012 |
| [0015](issues/0015-progress-stream.md) | 進捗のストリーミングと未完了タスク | **done** | — | 0014 |
| [0016](issues/0016-project-task.md) | Project と Task | **done** | — | 0014 |
| [0017](issues/0017-workflow.md) | Workflow の最小（定義・検証・実行） | **done** | — | 0016 |
| [0018](issues/0018-automations.md) | Automations（Schedule / Webhook） | **done** | — | 0017 |
| [0019](issues/0019-auth.md) | 認証と公開範囲（要件13） | **done** | — | 0014 |
| [0020](issues/0020-backup.md) | バックアップと復元（要件16） | **done** | — | 0014 |
| [0021](issues/0021-tailscale-auth.md) | tailnet の ID で認証する（要件13） | **置換**（0158） | — | 0019 |
| [0022](issues/0022-passkey.md) | passkey の登録・ログイン（要件13） | **done** | — | 0158 |
| [0023](issues/0023-prf-encryption.md) | PRF で秘密を暗号化（要件14） | **done** | — | 0022, 0024 |
| [0024](issues/0024-secret-scopes.md) | 秘密のスコープ分離（要件14） | **done** | — | 0019 |
| [0025](issues/0025-recovery-code.md) | 複数の包みと復旧コード（要件14） | **done** | — | 0023 |
| [0026](issues/0026-add-passkey.md) | 2台目のパスキーを追加する | **done** | — | 0025 |
| [0027](issues/0027-usage-limits.md) | 利用量と制限（要件15） | **done** | — | 0014 |
| [0028](issues/0028-observability.md) | 観測（要件17） | **done** | — | 0014 |
| [0029](issues/0029-conversation-management.md) | 会話の管理（要件20） | **done** | — | 0016 |
| [0030](issues/0030-safety.md) | 安全の残り（要件18） | **done** | — | 0014 |
| [0031](issues/0031-foundation.md) | 製品の土台（core・ゲート） | **done** | — | 0014 |
| [0032](issues/0032-migrate-packages.md) | 6パッケージへの移植 | **置換**（0033, 0034, 0047, 0100, 0145, 0146） | — | 0031 |
| [0033](issues/0033-workspace-package.md) | workspace パッケージ（移植） | **done** | — | 0031 |
| [0034](issues/0034-agent-package.md) | agent パッケージ（移植） | **done** | — | 0033 |
| [0035](issues/0035-server-package.md) | server パッケージ（移植） | **置換**（0145, 0146） | — | — |
| [0036](issues/0036-web-ui.md) | Web UI（最終段） | open | next | 0145, 0146, 0178 |
| [0037](issues/0037-http-contracts.md) | HTTP 契約と型付きクライアント | **置換**（D055 / 0188） | — | — |
| [0038](issues/0038-workflow-runtime.md) | Workflow / Automation の実行基盤 | open | next | 0145, 0146 |
| [0039](issues/0039-observability-product.md) | 観測の製品化 | open | next | 0145, 0146 |
| [0040](issues/0040-self-host.md) | セルフホストの配布 | open | next | 0036, 0145, 0146 |
| [0041](issues/0041-ci-dev-env.md) | CI と開発環境の固定 | open | later | 0046 |
| [0042](issues/0042-boundaries-knip.md) | 依存境界と未使用コードの検査 | **done** | — | 0031, 0046 |
| [0043](issues/0043-product-e2e.md) | 製品の E2E テスト | open | next | 0102, 0145, 0146, 0159, 0178 |
| [0044](issues/0044-multi-machine.md) | マルチマシン（保留） | **保留** | parked | — |
| [0045](issues/0045-review-hardening.md) | レビュー指摘の修正（workspace / core） | **done** | — | 0004, 0033, 0037 |
| [0046](issues/0046-test-discipline.md) | テストの規律とランナーを固定する | **done** | — | — |
| [0047](issues/0047-store-sqlite.md) | store の SQLite 基盤（migrations + repositories） | **done** | — | 0046 |
| [0048](issues/0048-store-identity.md) | store/identity（認証・秘密） | open | next | 0047 |
| [0049](issues/0049-agent-conversations.md) | agent の複数会話 API | open | next | 0034, 0046 |
| [0050](issues/0050-sse-events.md) | SSE の token / tool イベント | **置換**（0159） | — | — |
| [0051](issues/0051-parallel-work.md) | 並列ブランチのルールと前提の整理 | **done** | — | — |
| [0052](issues/0052-sandbox-hide-wiring.md) | sandbox の hide を起動時に配線する | **統合**（0147） | — | — |
| [0053](issues/0053-operationid-validation.md) | operationId の検証位置を決める | **done** | — | 0045 |
| [0054](issues/0054-same-name-swap.md) | 同名ファイルの差し替え窓（TOCTOU の残り） | **done** | — | 0005 |
| [0055](issues/0055-journal-save-batching.md) | Journal の保存を write 単位でまとめる | open | parked | 0045 |
| [0056](issues/0056-workspace-temp-cleanup.md) | workspace の temp を後片付けする | **置換**（0190） | — | 0045 |
| [0057](issues/0057-workspace-journal-temp-name.md) | journal の一時ファイル名を一意にする | **置換**（0190） | — | 0045 |
| [0058](issues/0058-workspace-audit-immutable.md) | auditLog を不変にする | **置換**（0190） | — | 0045 |
| [0059](issues/0059-agent-observe-bash.md) | agent の bash も観測する | open | next | 0034 |
| [0060](issues/0060-workspace-helper-reply-length.md) | helper の応答に長さの検証を入れる | **置換**（0190） | — | 0033 |
| [0061](issues/0061-workspace-intent-temp-type.md) | JournalIntent.temp の「無い」を型で表す | open | parked | 0045 |
| [0062](issues/0062-core-empty-patch.md) | 空の PATCH をどう扱うか決める | **置換**（0188） | — | — |
| [0063](issues/0063-core-contract-error-path.md) | ContractError に path を残す | **置換**（0188） | — | — |
| [0064](issues/0064-core-schema-naming.md) | スキーマの id と名前の命名を分ける | **置換**（0188） | — | — |
| [0065](issues/0065-store-low-followups.md) | store の low 残件（clock・ISO・comment） | open | parked | 0047 |
| [0066](issues/0066-invariant-codecs.md) | 不変条件を型と codec に寄せる（IsoTimestamp / OperationId） | **done** | — | 0047 |
| [0067](issues/0067-findings-registry.md) | レビュー findings の記録場所 | **done** | — | — |
| [0068](issues/0068-codec-low-followups.md) | codec review の low 残件 | **done** | — | 0066 |
| [0069](issues/0069-identity-secrets.md) | 秘密の暗号化（スコープと DEK） | open | next | 0048 |
| [0070](issues/0070-identity-passkey.md) | passkey の登録・ログインとセッション | open | next | 0048 |
| [0071](issues/0071-identity-dek-wraps.md) | 復旧コードと2台目のパスキー（DEK の包み） | open | next | 0069, 0070 |
| [0100](issues/0100-web-foundation.md) | Web の土台（React / Vite / typed client / fixtures） | **done** | — | 0037, 0046 |
| [0101](issues/0101-web-design-system.md) | Web のデザインシステムとプリミティブ | **done** | — | 0100 |
| [0102](issues/0102-web-app-shell.md) | App shell と hash router | **done** | — | 0101 |
| [0103](issues/0103-web-command-palette.md) | Command palette とキーボード操作 | open | next | 0102 |
| [0104](issues/0104-web-workspace-screen.md) | Workspace 画面（Running / Needs you / Completed） | open | next | 0102, 0115, 0117 |
| [0105](issues/0105-web-conversation-screen.md) | Conversation 画面（transcript / streaming / abort） | open | next | 0049, 0102, 0119, 0145, 0146, 0159 |
| [0106](issues/0106-web-editor-panel.md) | Editor 右パネル（CodeMirror / 保存 / 競合 / diff） | open | next | 0102 |
| [0107](issues/0107-web-settings-screen.md) | Settings 画面（provider / 秘密 / 制限 / backup / 観測） | open | next | 0039, 0102, 0122, 0123, 0124 |
| [0108](issues/0108-web-login-flow.md) | Login / passkey / recovery 画面 | open | next | 0070, 0071, 0102 |
| [0109](issues/0109-web-project-task-screen.md) | Project / Task 画面 | open | next | 0102, 0127 |
| [0110](issues/0110-web-workflow-run-screen.md) | Workflow / Run 画面（一覧・開始・human 入力） | open | next | 0038, 0102, 0129, 0159 |
| [0111](issues/0111-web-workflow-editor.md) | Workflow graph editor（ノード・辺・版） | open | next | 0110, 0130 |
| [0112](issues/0112-web-automation-screen.md) | Automation 画面（trigger / action / firings） | open | next | 0038, 0102, 0131 |
| [0113](issues/0113-web-responsive-a11y.md) | Responsive / accessibility / motion の仕上げ | open | next | 0104, 0105, 0106, 0107, 0108, 0109, 0110, 0111, 0112 |
| [0114](issues/0114-web-visual-review.md) | Web visual / interaction review（状態行列のスクリーンショット） | open | next | 0113 |
| [0115](issues/0115-api-workspace-overview.md) | Workspace overview API（Running / Needs you / Completed） | open | parked | 0037, 0049, 0145, 0146 |
| [0116](issues/0116-model-work-item.md) | WorkItem モデル（task / run / conversation を束ねる） | open | next | 0047, 0049, 0145, 0146 |
| [0117](issues/0117-api-ack.md) | Attention Ack API（確認済み・Undo） | open | next | 0047, 0116 |
| [0118](issues/0118-api-live-conversation.md) | SSE を conversation / overview 単位にする | **置換**（0159） | — | — |
| [0119](issues/0119-api-conversation-get.md) | 会話の単体取得と state のメタデータ | open | parked | 0037, 0145, 0146 |
| [0120](issues/0120-data-review-evidence.md) | Review evidence（変更ファイル・テスト・成果物） | open | later | 0033, 0039, 0145, 0146 |
| [0121](issues/0121-api-search-pagination.md) | 一覧の検索と cursor pagination | open | parked | 0047, 0145, 0146 |
| [0122](issues/0122-api-provider-catalog.md) | Provider / model catalog と鍵の検証 | open | next | 0034, 0037, 0145, 0146 |
| [0123](issues/0123-api-runtime-settings.md) | Runtime settings API（limits / default model / retention） | open | next | 0027, 0039, 0145, 0146 |
| [0124](issues/0124-api-backup-settings.md) | Backup の状態・実行・スケジュール API | open | next | 0145, 0146, 0164 |
| [0125](issues/0125-api-file-tree-search.md) | File tree と file search API | open | next | 0033, 0145, 0146 |
| [0126](issues/0126-api-notifications.md) | Attention 通知（in-app / desktop / webhook） | open | next | 0102, 0115, 0145, 0146, 0159 |
| [0127](issues/0127-model-project-workspace.md) | Project と Workspace root の関連 | open | now | 0033, 0047, 0145, 0146, 0159, 0198 |
| [0128](issues/0128-provider-oauth.md) | Provider の OAuth / token refresh | open | next | 0069, 0107, 0122 |
| [0129](issues/0129-api-run-cancel.md) | Workflow run のキャンセル | open | next | 0038, 0145, 0146 |
| [0130](issues/0130-api-workflow-archive.md) | Workflow の archive / delete | open | next | 0038, 0145, 0146 |
| [0131](issues/0131-api-automation-archive.md) | Automation の archive / delete | open | next | 0038, 0145, 0146 |
| [0140](issues/0140-cf-adoption-docs.md) | 正本を Cloudflare に置く決定と docs の書き換え | **done** | — | — |
| [0141](issues/0141-durability-contract.md) | 耐久の契約（ack の故障クラス・checkpoint・restore） | **done** | — | 0140 |
| [0142](issues/0142-lease-fencing.md) | lease と fencing（版チェックの委譲） | **done** | — | 0141 |
| [0143](issues/0143-secret-placement.md) | 秘密の配置（gateway・git はマシン・DEK） | **done** | — | 0140 |
| [0144](issues/0144-cf-deploy-env.md) | 配備と環境（cf CLI・cloudflare.config.ts・秘密の投入） | **done** | — | 0140 |
| [0145](issues/0145-worker-edge.md) | Worker の入口（認証境界・ルーティング・相関 ID） | **done** | — | 0144 |
| [0146](issues/0146-session-do.md) | Session DO（PiHarness・会話・run） | **done** | — | 0145 |
| [0147](issues/0147-machine-agent.md) | マシンエージェント（cloudflared・署名） | open | now | 0145 |
| [0148](issues/0148-machine-registry.md) | Machine レジストリ（D1 + fetch） | open | next | 0147 |
| [0149](issues/0149-d1-projection.md) | 会話の索引（D1） | open | next | 0146, 0150 |
| [0150](issues/0150-store-d1-do-backend.md) | store を D1 専用にする（node:sqlite の削除） | **done** | — | 0144 |
| [0151](issues/0151-provider-gateway.md) | provider gateway（鍵の分離・予算・緊急停止） | **done** | — | 0143, 0144 |
| [0152](issues/0152-real-provider.md) | 実プロバイダ（faux → 実・ストリーミング・usage） | open | next | 0146, 0151 |
| [0153](issues/0153-r2-object-store.md) | R2 オブジェクトストア（git object 互換・pack アップロード） | open | next | 0141, 0144 |
| [0154](issues/0154-checkpoint-commit.md) | checkpoint commit（refs/hns・Run 境界） | **done** | — | 0153, 0156 |
| [0155](issues/0155-restore.md) | restore（base + Journal の再生） | open | next | 0154 |
| [0156](issues/0156-journal-in-do.md) | Workspace DO の骨格（lease・版・所有） | **done** | — | 0142, 0145 |
| [0157](issues/0157-versioned-write-remote.md) | 版付き書き込みのリモート化（ack が DO を通る） | **done** | — | 0033, 0147, 0156 |
| [0158](issues/0158-auth-edge.md) | 認証の再編（passkey / PRF / デバイス鍵） | open | next | 0048, 0069, 0070, 0071, 0147 |
| [0159](issues/0159-live-ws.md) | ライブ更新の WS 化（SSE の置き換え） | open | now | 0146 |
| [0160](issues/0160-ui-delivery.md) | UI の配信（Workers Assets・typed client） | open | next | 0037, 0159 |
| [0161](issues/0161-automation-target.md) | automations の実行先（マシン必須の明示） | open | next | 0038, 0148 |
| [0162](issues/0162-observability-hops.md) | 観測（相関 ID を全ホップに通す） | **done** | — | 0145, 0147 |
| [0163](issues/0163-cost-and-limits.md) | コストの上限と監視（DO 行・R2・モデル） | **done** | — | 0151, 0153 |
| [0164](issues/0164-backup-restore-ops.md) | バックアップと復元の運用（0020 の再定義） | open | next | 0154 |
| [0165](issues/0165-safety-reeval.md) | 安全の再評価（XSS→exec・サプライチェーン・egress） | open | next | 0147 |
| [0166](issues/0166-migration-rollback.md) | 移行とロールバック（ローカル実装を残す） | open | next | 0150, 0157 |
| [0167](issues/0167-remote-fault-injection.md) | リモート経路の故障注入（intent / apply / outcome） | open | next | 0157, 0169 |
| [0168](issues/0168-retention-gc.md) | checkpoint と R2 の保持（GC・保持期間） | open | next | 0154, 0155 |
| [0169](issues/0169-journal-truncation.md) | Journal と切り詰め（append・watermark・256KB閾値） | **done** | — | 0141, 0156 |
| [0170](issues/0170-integration-tier.md) | integration 層を分ける | **done** | — | - |
| [0171](issues/0171-build-prepush.md) | build を pre-push に移す | **done** | — | 0170 |
| [0172](issues/0172-rooted-helper-spawn.md) | rooted ヘルパーの起動を操作ごとにしない | **置換**（0191） | — | - |
| [0173](issues/0173-docs-followups.md) | D047〜D053 採用後の docs の残り | open | later | 0140 |
| [0174](issues/0174-staged-content-merge.md) | ステージ内容と merge をゲートで覆う | **done** | — | 0170, 0171 |
| [0175](issues/0175-graphql-relay-foundation.md) | core で SDL を起こす | **done** | — | 0037 |
| [0176](issues/0176-graphql-endpoint.md) | Worker に /graphql を載せる | **done** | — | 0145, 0146, 0150, 0175 |
| [0177](issues/0177-global-id.md) | global id（Relay の store 要件） | **done** | — | 0176 |
| [0178](issues/0178-web-relay-environment.md) | web の Relay environment と test harness | **done** | — | 0177 |
| [0179](issues/0179-sidebar-relay.md) | サイドバーを Relay で読む | **done** | — | 0178, 0102 |
| [0180](issues/0180-codegen-gate.md) | relay-compiler をゲートに組み込む | **done** | — | 0175, 0178 |
| [0188](issues/0188-graphql-only-contract.md) | GraphQL を唯一の契約にする（REST 契約の撤去） | **done** | — | — |
| [0181](issues/0181-store-freshness.md) | store の鮮度方針 | open | next | 0159, 0179 |
| [0182](issues/0182-surface-inventory.md) | GraphQL 以外に残す面の棚卸し | open | next | 0179 |
| [0183](issues/0183-test-management.md) | テスト管理の再設計（TSDoc・コロケート・doctest） | **done** | — | — |
| [0184](issues/0184-vitest-assertions.md) | テストのアサーションを Vitest の expect に統一する | **done** | — | 0185 |
| [0185](issues/0185-tiers-removal.md) | tiers の二重実行を廃止する | **done** | — | 0183 |
| [0186](issues/0186-test-colocation.md) | テストをコロケートし、issue 参照を削除する | **done** | — | 0184, 0185 |
| [0187](issues/0187-tsdoc-doctest.md) | TSDoc 契約と doctest を展開する | **done** | — | 0186 |
| [0189](issues/0189-d1-wiring.md) | Worker から D1 の store を開通させる | **done** | — | 0145, 0150 |
| [0190](issues/0190-workspace-debt.md) | workspace の低負債を一括で閉じる（0056・0057・0058・0060） | **done** | — | 0045 |
| [0191](issues/0191-workspace-perf.md) | workspace の実行性能を測って固定する（0172） | open | next | 0190 |
| [0192](issues/0192-findings-reconcile.md) | findings 13 件を再判定し、直す | open | later | 0145, 0146 |
| [0193](issues/0193-backlog-metadata.md) | backlog のメタデータを現在に合わせる | open | later | 0141, 0146 |
| [0194](issues/0194-machine-sandbox.md) | machine の sandbox・hide・env 純度（0147 から分割） | open | next | 0147 |
| [0195](issues/0195-work-record-contract.md) | 仕事の記録の契約（意図・方針・判断） | **done** | — | — |
| [0196](issues/0196-record-package.md) | 構造化レコードの実装（@hns/record・YAML・CLI） | **done** | — | 0195 |
| [0197](issues/0197-record-product-integration.md) | 記録の製品統合（WorkItem / Evidence への写像） | open | next | 0116, 0120, 0196 |
| [0198](issues/0198-graphql-mutation.md) | GraphQL の Mutation 面（書き込みの骨格） | **done** | — | 0176 |
| [0199](issues/0199-code-mode-contract.md) | code mode の実行契約（profile・event・budget・モジュール境界） | open | next | - |
| [0200](issues/0200-code-mode.md) | code mode（codemode・sandbox・structured output） | open | next | 0199 |
| [0201](issues/0201-subagent-budget.md) | subagent と実行予算（深さ・本数・usage） | open | next | 0199 |
| [0202](issues/0202-code-mode-session.md) | code mode の Session 合成（profile・codemode・subagent・budget・event） | open | next | 0049, 0199, 0200, 0201 |
| [0203](issues/0203-code-mode-server.md) | code mode の Session DO 配線（profile RPC・sandbox access・event sink） | open | next | 0202 |
| [0214](issues/0214-codemode-sandbox-deploy.md) | sandbox Worker（RemoteCodemodeSandbox の配備） | open | next | 0203 |
| [0215](issues/0215-code-mode-live-ui.md) | code mode のライブ表示（WS frame・プログラムカード・profile 切替） | open | next | 0105, 0203 |
| [0216](issues/0216-code-mode-eval.md) | code mode の評価セット（direct と code の比較） | open | next | 0200, 0201, 0202 |
| [0220](issues/0220-capability-contract.md) | capability 契約（canonical call・grant・policy 型） | open | next | - |
| [0221](issues/0221-agent-call-identity.md) | Agent のツール呼び出しに manifest と callHash を付ける（Phase 0） | open | next | 0220 |
| [0222](issues/0222-audit-chain.md) | ツール決定の監査を Session DO に追記する（hash chain） | open | next | 0220 |
| [0223](issues/0223-policy-revisions.md) | ポリシー改訂・提案・承認（review token・CAS） | open | next | 0220 |
| [0224](issues/0224-grant-issuance.md) | Session DO で capability grant を発行・署名する | open | next | 0220, 0223, 0148 |
| [0225](issues/0225-machine-verifier.md) | Machine 側で grant を検証し、ローカルで許可/拒否する | open | next | 0220, 0148, 0194 |
| [0226](issues/0226-granted-execution.md) | grant をツール実行に通す（agent / workspace / machine の統合） | open | next | 0221, 0222, 0224, 0225, 0147, 0157 |
| [0227](issues/0227-sandbox-hardening-spike.md) | sandbox 追加硬化の実測（Landlock / netns+proxy / seccomp） | open | next | - |
| [0228](issues/0228-policy-graphql.md) | ポリシー承認の GraphQL 面（Query / Mutation） | open | next | 0223, 0198 |
| [0229](issues/0229-policy-approval-ui.md) | ポリシー承認の UI（提案・差分・承認） | open | next | 0228, 0160 |

## ゲート

- [0001 M2 → 会話の実結線](gates/0001-m2-to-conversation.md): **Go with Conditions（承認済み・完了）**
- [0002 統合 MVP](gates/0002-integrated-mvp.md): **Go with Conditions（承認済み・完了）**

## ユーザー判断待ち

| # | 論点 | 案 |
| --- | --- | --- |
| D-1 | D001（1.5.0固定・Workspace層） | **採用済み** |
| D-2 | 要件#2 の配置 | **A'' で開始**（D047。D004 を置換、[分解](../docs/topology.md)） |
| D-3 | MVP 範囲 | **採用済み**（D003） |
| D-4 | UI を前倒しするか | **採用済み**（D043、0100–0131） |
| D-5 | 正本を Cloudflare に置くか | **採用済み**（D047–D049、0140–0169。実行は手元のまま） |

## 調査・検証

- [research/pi-durable-1.5.0.md](research/pi-durable-1.5.0.md): API・適合・失更新・封じ込め
- [research/wasm-editor.md](research/wasm-editor.md): WASM・CRDT・通信の測定
- [research/](research/): 提供資料の原文（agentics / agent engineering / 開発プロセス / 設計プレイブック / 要件状態 v0.3）
- [poc/](poc/): conformance / mutation-gap / root-containment / root-swap / daemon-life / workspace-core / walking-skeleton / sandbox / pi-agent


## 残り（棚卸し 2026-11-06）

### 要件

| # | 状態 | 残り |
| --- | --- | --- |
| 1 セルフホスト | △ | 配布・設定・バックアップ・更新の手順がない |
| 2 複数マシン | ✗ | 下げ中（T-05） |
| 3 全マシンを1UIで | ✗ | 2 に依存 |
| 4 チャット | △ | 履歴一覧、中断、トークンのストリーミング |
| 5 プロジェクト | △ | API のみ。Workspace との関連、UI |
| 6 ワークフロー | △ | 逐次実行のみ。並列・分岐・再試行・耐久 |
| 7 タスク | △ | API のみ。Run / Conversation との関連 |
| 8 Provider | △ | 鍵の管理、OAuth、能力差の吸収 |
| 9 Editor | △ | ツリー操作、検索、構文、Git 連携 |
| 10 Git diff | ✗ | Want |
| 11 Grabber | ✗ | Want |
| 12 Automations | △ | 認証、再試行、通知 |

### 横断（要件番号）

| # | 要件 | いまの状態 |
| --- | --- | --- |
| 13 | 認証・認可と公開範囲 | passkey・デバイス鍵（0158）。tailnet の入口認証は廃止 |
| 14 | 秘密の管理 | スコープ分離・PRF・復旧コード・2台目追加 |
| 15 | 利用量と制限 | 記録・レート・予算・タイムアウト・中断（0027） |
| 16 | データの保全 | 取得・復元（0020）。定期化は未 |
| 17 | 観測 | 全ライフサイクルのイベント（0028）。時系列と外部送出は未 |
| 18 | 安全 | sandbox 検出・.git 拒否・試行制限（0030）。マシンの認証と隔離は 0147 / 0165 |
| 19 | 開発・検証基盤 | node は固定（0004）、CI なし（0041） |
| 20 | 会話の管理 | 改名・アーカイブ・論理削除・タイトル検索（0029） |
| 21 | UI / UX の仕上げ | 最小のまま（D011） |

（ドキュメントは要件に含めない。必要になったら別枠で。）

### 下げたもの

- 2マシン（T-05）
- WASM エディタ（0010）

## 並列の単位

D047 以前の波は、下の **D049 のレーン**に置き換わった。以下は一般則だけ残す。


- 依存が未マージのブランチは、その issue のファイルを触らない。
- 波が終わるまで次をマージしない、という意味ではない。`depends-on` を満たしたものから積む。
- `packages/workspace` を触る 0053 → 0054 → 0055 は直列。0052 は 0147 に統合済み。

### D049 のレーン（並列の単位）

各レーンは**ファイル名前空間を占有する**。同じレーンの中だけ直列。レーン間は依存点でだけ待つ。

| レーン | 所有するパス | issue の流れ |
| --- | --- | --- |
| L0 契約 | `docs/`, `packages/core/src/{durability,lease}.ts` | 0140 → 0141 → 0142 ∥ 0143 |
| L0c 撤去 | `packages/core/src/`, `packages/web/src/`, `docs/packages.md` | 0188（L1 より先） |
| L1 基盤 | `deploy/`, `package.json`, `server/src/edge/`, `packages/store/src/`（L5 の `conversation-index/` を除く） | 0144 → 0145、0150 は 0145 の後、0189（D1 の開通）は 0150 の後 |
| L2 会話 | `server/src/do/session.ts`（PiHarness・1 ワークスペース 1 つ）, `packages/agent/`, `core/src/stream.ts` | 0146 → 0152 ∥ 0159 |
| L3 マシン | `packages/machine/`, `server/src/machines/`, `core/src/machine.ts` | 0147 → 0194 ∥ 0148 ∥ 0165 |
| L4 耐久 | `workspace/src/*`, `server/src/do/{workspace,journal}.ts`, `server/src/routes/files.ts` | 0190 → 0191 ∥ 0153 → 0156 → 0169 ∥ 0157 → 0154 → 0155 → 0168 → 0167 |
| L5 索引 | `store/src/conversation-index/`, `server/src/graphql/` | 0149 |
| L6 認証 | `server/src/auth/`, `core/src/auth.ts` | 0158 |
| L7 Web | `packages/web/`, `deploy/assets/` | 0160 |
| L8 運用 | `server/src/{obs,cost,runtime,automations}/`, `core/src/{workflow,observability}.ts`, `docs/{backup,safety}.md` | 0161 ∥ 0162 ∥ 0163 ∥ 0164 → 0166 |
| L9 ゲートウェイ | `server/src/gateway/` | 0151 → 0152 と合流 |

**着手できるのは L0 と L0c が終わってから。** L0 の後に L1 が開き、L1 の後に L2〜L7 と L9 が同時に走れる。
L4 だけは 0147（L3）を待つ。

### 直列化点（触るファイルが重なる場所）

| ファイル | 所有者 | 扱い |
| --- | --- | --- |
| `packages/server/src/routes/index.ts` | 0145 | 以降のレーンは自分のルートを1行足すだけ。マージ直前に rebase |
| `packages/server/src/edge/handler.ts` | 0145 | 面の依存は加算。面を足すレーンは1本ずつ |
| `tools/deploy/worker.ts` | 0146 | binding と entrypoint の追記は1レーンずつ |
| `tools/deploy/cloudflare.config.ts` | 0189 | D1 の binding を1回足す。以後は加算 |
| `work/BOARD.md` / `work/LANES.md` | lead | レーンは触らない。統合のたびに lead が更新する |
| `package.json` | 0144 → 0150 | lock owner。0150 が miniflare の devDependency を1件だけ足した。以降は依存を足さない |
| `docs/safety.md` | 0143 | 0165 は 0143 の後に書く |
| `docs/workspace.md` | 0141 | 0142 は触らない（型だけ） |
| `cloudflare.config.ts` | 0144 | Cron Triggers と Assets の追記は 0160 / 0161 が1行ずつ |

### 分割・統合（D047〜D049）

- **0156 を分割**。Workspace DO の骨格（lease・版・所有）と Journal（append・切り詰め）はファイルが別（`do/workspace.ts` と `do/journal.ts`）。Journal は **0169**。
- **D049**: PiHarness は維持したまま、1 会話 = 1 DO をやめて **1 ワークスペース = 1 Session** にした。残る DO は Session DO と Workspace DO の 2 クラスだけ。制御レコードは D1、machine は D1 + fetch、予算は D1 の 1 文、automations は Cron Triggers。
- **0149 を縮小**。制御データは D1 が正本なので投影しない。索引は会話だけ（run の状態は 0115 / 0116）。

### 置換の対応（D047）

| 旧 | 新 |
| --- | --- |
| 0035 server（移植） | 0145（Worker の入口）+ 0146（Session DO） |
| 0050 / 0118 SSE | 0159（WS） |
| 0021 tailnet 認証 | 0158（デバイス鍵） |
| 0052 sandbox の hide | 0147（マシンエージェント）に統合 |
| 0020 バックアップ | 0164（運用の再定義） |

既存 issue の `depends-on` は、この表に従って置換する。`status: superseded` の issue は触らない。

## 完成までの順序（D047 以前・履歴）

0. **規律**: 0051 並列ルール → 0046 テスト
1. **道具**: 0042 knip（0041 CI は優先度低・後回し）
2. **基盤**: 0047 store → 0048 identity / 0049 agent / 0050 SSE
3. **サーバ**: 0035（0145 / 0146 に置換）
4. **UI**: 0036 → 0043
5. **配布**: 0040
6. **残り（レビュー由来）**: 0052（0147 に統合） / 0053 → 0054 → 0055（workspace）
7. **保留**: 0044 マルチマシン（1マシン完成後）

要件との対応（D047 以前）: 1 → 0040、2/3 → 0044、4〜9 → 0035/0036、12 → 0038、13/14 → 0035、15 → 0035、16 → 0040、17 → 0039、18 → 0005/0006、19 → 0041、20 → 0036、21 → 0036/0043。

## 完成までの順序（現行、D047〜D049・D053）

**Cloudflare 採用**: L0 契約（0140 → 0141 → 0142 / 0143）→ 0188 契約の撤去 → L1 基盤（0144 / 0150 → 0145 → 0189）→ L2〜L7・L9 を並列 → L4 耐久（0156 → 0169 / 0157 → 0154 → 0155 → 0168）→ 運用（0161〜0167）。
レーンの詳細は上の「D049 のレーン」を見る。

## 優先度

- **UI の作り込みは最後**（D011）。先に型・検証・サーバを固める。
- 2マシン（T-05）は**保留**。1マシンの完成を先にする。

## 制約

- 危険な Tool は Worker 認可が完成するまで公開しない。
- 外部副作用の exactly-once を前提にしない。