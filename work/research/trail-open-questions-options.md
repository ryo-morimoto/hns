# Trail の未解決問い: 背景・3案・推奨

2026-11-17 / 関連: [Trail モデル v1](trail-model-v1.md) / [批判と課題](trail-model-critiques.md) / [ゲート設計](trail-and-gates-decision.md)

## 0. 読み方

各問いに対して、**背景・意図**（なぜ迷うか、何を守るか）、**差分の大きい3案**（保存場所・判断者・強制方法が変わるもの）、**推奨**（理由・移行・反転条件）を出す。UI の見た目だけが違う案は置かない。

## 決定（2026-11-17）

| 問い | 決定 |
| --- | --- |
| Q1 session | B: summary 既定 + R2 全文 + reveal 監査 + TTL |
| Q2 metric | B: 実験紐づけ。Phase 1 は相関 + 実験フィールド |
| Q3 observing | A: 14 日固定 + 手動 reopen |
| Q4 保持 | A: TTL クラス + tombstone |
| Q5 複数人 | A いま / B ターゲット |

## Q1. session の全文をどこまで見せるか

### 背景・意図

- Trail の価値は「why が session に残る」こと。だが session 全文は PII・secret・顧客データを含み得る。
- Entire は repo の refs に置くため、**repo の read 権限がある人全員が読める**。public repo なら公開。redaction は保証ではない（Entire security docs）。
- hns は実行がマシン、正本が Cloudflare（D047）。transcript は Session DO（pi-durable）にあり、全文を repo に入れる必要はない。
- 迷いどころ: **review 中の可読性**（全文が見たい）と、**漏洩時の影響**（消せない・広がる）のトレードオフ。

### 選択肢

| 案 | 仕組み | 利点 | 欠点 | 反転 |
| --- | --- | --- | --- | --- |
| **A. ローカル保持** | 全文はマシンに残す。Trail には redaction 済み summary と hash だけ。incident 時はマシンに繋いで読む | 漏洩面が最小。保存コストほぼゼロ | マシン喪失で全文が消える。remote review/監査ができない | 高（保存を足すだけ） |
| **B. 階層化（推奨）** | 既定は summary + redacted excerpt。全文は R2 に暗号化保存し、**明示 reveal + 理由 + 監査 + TTL** で見る。review 中は summary、incident 時だけ全文 | レビューは軽く、forensics は残る。アクセスを記録できる | 保存・redaction・アクセス制御・TTL の実装が要る。運用で「reveal しすぎ」が起き得る | 中（既定を A に戻せる） |
| **C. 全文を既定で集中** | 全文を DO/R2 に保存し、project の read 権限で閲覧 | 実装が単純。review も監査も楽 | 漏洩時の影響が最大。容量・コスト・削除要求が重い | 低（既に保存した分は消すのが難しい） |

### 推奨: B（段階的に）

- **Phase 1**: 保存は B の形（summary + R2 の全文 + TTL）だが、UI は summary のみ。reveal は owner だけ、理由必須、監査ログ。
- **Phase 2**: project の approver も reveal 可。incident 用の一時昇格（24h）と通知。
- **保存しないもの**: secret の raw 値、画像・base64（externalize か落とす）、顧客の自由記述（redaction 後に残す）。
- **repo には入れない**。Entire のように git refs へ置くと、repo の権限と保存期間に縛られる。hns は R2 + DO の参照にする。
- **プロジェクト設定で全文保存をオフにできる**（`transcript_storage: r2 | none`）。オフのときは A と同じ挙動。
- **反転条件**: reveal の監査が回らず、incident 対応で全文が要らないと分かれば A に戻す。

### 実装への影響

    trail_sessions: summary, transcript_ref(R2 key), transcript_bytes,
                    redaction_version, revealed_at, reveal_reason, expires_at

- 配信は Worker 経由。R2 の署名 URL を直接クライアントに渡さない。
- reveal は audit イベント（誰が・いつ・なぜ）。
- 既定 TTL は 30 日（Q4 と連動）。

## Q2. metric の因果をどこまで扱うか

### 背景・意図

- 「変更の結果」を後から attach すると、意思決定に効く。だがメトリクスは多くの要因で動く。
- 代理指標の失敗: 「summary viewed」が実は 94% スクロール通過で、11 か月間「使われている」と信じられた。**測定が主張になった**（Kuralok）。
- Goodhart: 指標が目標になると指標が歪む。ゲートにすると特に危険。
- 迷いどころ: **相関を見せるだけでは弱い**が、**因果を名乗ると嘘になる**。

### 選択肢

| 案 | 仕組み | 利点 | 欠点 | 反転 |
| --- | --- | --- | --- | --- |
| **A. 相関のみ** | metric を observation として attach。時系列に並べる。因果は言わない | 正直。実装が最小。誤解を生みにくい | 「で、効いたの？」に答えられない。意思決定に使いにくい | 高 |
| **B. 実験と紐づけ（推奨）** | metric に experiment_id / variant / hypothesis を持たせる。実験がある時だけ因果を言い、無い時は相関 | 因果の主張に根拠を持てる。A/B と接続できる | 実験の運用（feature flag・割当・期間）が要る。実験が無い領域は A のまま | 中 |
| **C. metric ゲート** | 閾値を満たさなければ merge しない / 悪化で自動 reopen | 自動化できる。変更追従が強い | 因果・ノイズ・遅延で誤判定。Goodhart。ゲートがリリースを止める | 低（ゲートは信頼を壊しやすい） |

### 推奨: B（Phase 1 は A の実装 + 実験フィールド）

- **Phase 1**: `trail_metrics` に definition / window / source / hypothesis / experiment_id / variant を持たせる。UI は「observed」と表示。ゲートにしない。
- **Phase 2**: experiment がある metric だけ「experiment evidence」と表示。因果の主張は experiment_id がある時だけ許可。
- **ゲートにしない**。metric は判断材料で、自動 merge / 自動 reopen の根拠にしない（C を採らない）。
- **反転条件**: 実験基盤が安定し、誤判定のコストが下がったら、限定的な metric gate（例: 1 指標・高閾値・bypass 可）を検討。

### 実装への影響

    trail_metrics: definition, hypothesis, experiment_id?, variant?,
                   window_start, window_end, source, external_id
    trail_experiments: id, trail_id, name, variants, started_at, ended_at

- UI のラベル: 「observed」「experiment evidence」。
- 因果の断定表現を禁止する（「改善した」ではなく「この窓では X だった」）。

## Q3. observing の期間と自動 reopen の閾値

### 背景・意図

- merged で終わると「変更追従」ができない。長く observing すると通知と状態遷移が増える。
- hns の原則は「今、人間の注意が必要なものを最初に見せる」。observing は注意を奪いすぎてはいけない。
- 迷いどころ: **期間を固定するか、信号で決めるか**。

### 選択肢

| 案 | 仕組み | 利点 | 欠点 | 反転 |
| --- | --- | --- | --- | --- |
| **A. 固定窓（推奨）** | merge 時に observe_until（既定 14 日）。期間終了で closed。reopen は手動のみ | 予測可能。通知が増えない。実装が単純 | 期間が短い/長い問題。自動追従は弱い | 高 |
| **B. 信号駆動** | metric / feedback の閾値で自動 close / reopen。cooldown と上限付き | 変化に強い。自動で追従 | 誤検知・チャーン・通知疲れ。閾値の調整が要る | 中 |
| **C. observing なし** | merge = closed。信号は closed の Trail に attach だけ | 最小。状態が増えない | 「変更追従」の体験が弱い。regression を見落とす | 高 |

### 推奨: A（Phase 1）、B は opt-in で Phase 2

- **Phase 1**: 14 日固定。closed 後も attach は可。reopen は手動（理由必須）。
- **Phase 2**: 自動 reopen は「experiment がある」「severity high の feedback」「metric が定義済み」のいずれかを満たす時だけ。cooldown 7 日、最大 1 回/窓。
- **通知**: observing の間は daily digest にまとめ、即時通知は high のみ。
- **反転条件**: 誤 reopen が週 1 回を超える、または closed 後の見落としが起きたら、期間と閾値を見直す。

### 実装への影響

    trails: observe_until, observing_closed_at, reopen_count,
            last_reopen_at, reopen_reason

- Cron Trigger で期限切れを closed に。
- reopen は Decision として記録（actor / reason / signal_id）。

## Q4. feedback / metric の保持期間と削除要求

### 背景・意図

- feedback には PII・顧客情報が入り得る。metric は長期比較に使う。session 全文は容量が大きい。
- 「追記専用」と「削除要求」は衝突する。監査のために消した記録（tombstone）は残す必要がある。
- 迷いどころ: **誰が保持期間を決めるか**（全体 / プロジェクト / 永久）。

### 選択肢

| 案 | 仕組み | 利点 | 欠点 | 反転 |
| --- | --- | --- | --- | --- |
| **A. 全体 TTL クラス（推奨）** | transcript 30 日、summary/findings 1 年、feedback/metric 2 年、Trail/Decision は無期限 | 実装が単純。privacy と監査のバランス | プロジェクトごとの事情に合わない | 高 |
| **B. プロジェクト別ポリシー** | プロジェクトごとに保持クラス + legal hold。削除要求はプロジェクト単位 | 柔軟。将来のマルチユーザー/顧客データに対応 | 設定・UI・監査が増える | 中 |
| **C. 永久保存** | すべて残す | 監査に強い。実装が単純 | privacy・コスト・削除要求に弱い | 低（消せない） |

### 推奨: A + B の seam

- **Phase 1**: 全体 TTL クラス。プロジェクトに `retention_class` 列（既定 standard）だけ置く。
- **削除の意味**: payload を削除し、tombstone（id / kind / deleted_at / reason / actor）を残す。監査は tombstone を見る。
- **削除要求**: 対象 payload を hard delete、tombstone を残す。export は削除前に可能。
- **legal hold**: Phase 2。プロジェクト単位で削除を止める。
- **反転条件**: 顧客データを扱うプロジェクトが出たら B に上げる。

### 実装への影響

    retention_class: standard | extended | legal_hold
    deleted_at, deleted_reason, deleted_by（payload 削除の tombstone）

- 定期削除は Cron Trigger。
- 削除は audit イベント。

## Q5. マルチユーザー時の承認者割当（RBAC をどこまで作るか）

### 背景・意図

- いまは単一ユーザー。将来は複数人の可能性が高い。
- ただし hns の README は「チーム向け RBAC、公開 SaaS」を**やらないこと**にしている。ここは**方針の衝突**であり、先に決める必要がある。
- レビュー承認と capability 承認（tool の効果）は別物。混ぜると権限モデルが崩れる。
- 迷いどころ: **役割を持つか、能力（capability）で計算するか**。

### 選択肢

| 案 | 仕組み | 利点 | 欠点 | 反転 |
| --- | --- | --- | --- | --- |
| **A. owner-only** | 承認者は owner 1 人。役割なし。README の非目標と一致 | 最小。単一ユーザーに最適 | 複数人が来たら作り直し | 高 |
| **B. プロジェクト役割（推奨ターゲット）** | owner / approver / editor / viewer。承認ポリシー（最小数・作者除外・path / risk） | 小規模チームに十分。実装が読める | 役割とポリシーの UI・監査が要る | 中 |
| **C. capability / policy engine** | 行為ごとの grant と条件で承認を計算。path・risk・時間・回数を含む | 最も細かい。既存 capability と一体 | 複雑。デバッグが難しい。RBAC の一般解を作りがち | 低（過剰） |

### 推奨: いまは A、ターゲットは B（C は採らない）

- **いま**: actor_id / created_by を Trail / Change / Decision に入れる。承認は owner 1 人。
- **トリガー**: 2 人目の実ユーザーが決まった時点で B。`project_members(project_id, actor_id, role)` と `approval_policies` を足す。
- **やらない**: SSO / SCIM / 組織階層 / CODEOWNERS の完全再現。
- **分離**: capability 承認（tool の効果）は既存の policy に残す。レビュー承認は Trail の Decision。UI のキューは共通化してよい。
- **README の非目標を更新するか**を先に決める。B をターゲットにするなら「チーム向け RBAC」の記述を「フル RBAC / SSO はやらない。プロジェクト役割までは許容」に変える。
- **反転条件**: 複数人が同一 workspace を同時編集する要求が出たら、lease（INV-13）と役割の整合を再設計する。

### 実装への影響

    project_members(project_id, actor_id, role)
    approval_policies(project_id, min_approvals, author_counts, path_rules, reset_on_push)
    trail_decisions: actor_id, actor_role

- 認可は boundary（Worker）で確認。UI の状態を信じない。
- 監査に actor / role / policy を残す。

## まとめ

| 問い | 推奨 | Phase | 反転のしやすさ |
| --- | --- | --- | --- |
| Q1 session 公開 | B: summary 既定 + 全文は R2・reveal 監査・TTL | 1: 保存と summary、2: reveal 拡張 | 中 |
| Q2 metric 因果 | B: 実験と紐づけ。Phase 1 は相関 + 実験フィールド | 1: 相関、2: 実験 evidence | 中 |
| Q3 observing | A: 14 日固定 + 手動 reopen | 1: 固定、2: opt-in 自動 | 高 |
| Q4 保持 | A: TTL クラス + tombstone、B の seam | 1: TTL、2: legal hold | 高 |
| Q5 複数人承認 | A いま / B ターゲット | 2 人目で B | 中 |

**決める順**: Q5 の方針（README の非目標を更新するか）→ Q1（保存とアクセスの前提）→ Q3 / Q4（運用）→ Q2（実験基盤待ち）。

## 決め方（この推奨が変わる条件）

- Q1: reveal の監査が運用に乗らない、または全文の中央保存が許容できない → A。
- Q2: 実験基盤が無く、metric を判断に使わない → A のまま。
- Q3: 誤 reopen が運用を圧迫する → 期間延長か C。
- Q4: 顧客データを扱うプロジェクトが出る → B。
- Q5: 2 人目のユーザーが来ない → A のまま（README もそのまま）。

## 参考

- [Trail モデル v1](trail-model-v1.md) / [批判と課題](trail-model-critiques.md)
- Entire security（session の可視性・redaction）: https://docs.entire.com/security
- 代理指標の失敗: https://kuralok.com/p/we-shipped-a-feature-nobody-used-for-eleven-months-because-the-metric-loved-it
- LLM judge の bias: https://arxiv.org/html/2603.24586v1 / https://arxiv.org/html/2604.16790
- hns: README.md（やらないこと）/ docs/durability.md / docs/capability.md
