# 不変条件（invariant）

2026-11-18 / L6 M1。**この台帳が唯一の定義**。他はここを参照する（[ARCH.md](../ARCH.md) の表、[durability.md](durability.md) §9、[workspace.md](workspace.md)、[observability.md](observability.md) は要約とリンクだけを持つ）。

不変条件は「破ったら製品が間違っている」条件。実装の手段は変えてよいが、条件を弱めるには [decisions](decisions.md) の追記が必要。各行は **条件 / なぜ / どこで確かめるか**。

| ID | 条件 | なぜ | 確かめる場所 |
| --- | --- | --- | --- |
| INV-01 | Agent Run は認可済みの Workspace と Execution Target にだけ紐づく | 認可をすり抜けた Run がファイル空間を動かすと、越境がそのまま事故になる | `server/edge` の認可、`machine` の ROOT 封じ込め |
| INV-02 | Machine Agent は Mutation のたびに ROOT の同一性と権限を検証する | root の差し替え・別プロジェクトへの書き込みを、パスではなく実体で止める | `machine/agent` の dev/ino 照合、`files.ts` の dirfd walk |
| INV-03 | 版付き書き込みは古い内容を黙って上書きしない（DO の直列化 + マシンの再ハッシュの二段） | 読んだ版と書く版がずれた保存を、conflict として返す | 0157 の `workspace` / `files`、`do/workspace` の版表 |
| INV-04 | 再送は既存結果を返すか照合する。盲目的に再適用しない（intent が先、outcome が後） | ack を失った保存を二重に適用しない | journal の operationId 照合、`unknown` → 照合 |
| INV-05 | checkpoint と外部 Mutation は別トランザクション。U は Run 境界で commit されるまで durable でない | クラッシュで失う範囲を Run に閉じる | `checkpointRun`、durability §5 |
| INV-06 | Progress は永続化済みの事実（J とイベント）から復元できる | 表示のための別の真実を作らない | journal の再生、trace CLI |
| INV-07 | Editor の dirty Buffer は外部変更で黙って上書きられない | 入力中の内容を失わない | 0106 の conflict（未実装） |
| INV-08 | User Task と Durable 内部 Task は別 ID・別ライフサイクル | 利用者のタスクと実行の手順を混ぜない | core のモデル、store の schema |
| INV-09 | 正本は `(C, J)`。作業ツリーは写像であり、失ってよい | 復元の起点を 1 つに決める | durability §1–§2 |
| INV-10 | ack は単一システムで閉じる（DO の 1 トランザクション、または R2 → DO の順） | 「保存した」と言った時点で失ってはいけない | journal の settle（1 transaction）、0153 の pack |
| INV-11 | 索引は写し。正本は DO にあり、D1 の索引は DO から作り直せる。索引の更新失敗は操作を止めない | 索引の障害が会話を止めない・一覧は再構築できる | 0149 の `session-index`（dirtyAt + CAS）、`reindex` |
| INV-12 | 実行中の状態は DO、確定したレコードは D1。どちらも他方の複製を正本にしない | 書き込みの正本を 1 つに決める | D049、`cost_turn` / `obs_events` の配置 |
| INV-13 | 書き込みの権利は lease で 1 台に閉じる。未取得・期限切れ・古い epoch は fail closed | 2 台同時の書き込みを構造で防ぐ | `core/lease`、0142、`do/workspace` の epoch |

## 番号の使い方

- 番号は**追記のみ**。条件を弱める・消すときは、台帳の行を残したまま取り消し線を引き、理由を [decisions](decisions.md) に書く。
- 移行（migration）は INV-12 の対象だったが、リリース前の方針で**加算の制約を外した**（後方互換を管理しない）。破壊的 migration は 1 本にまとめ、正本へ移行しないことを TSDoc とここに書く（0006 が最初の例）。
- 新しい不変条件は次の番号で足す。ID を再利用しない。

## 参照の規則

- 各 docs と ARCH は**表を持たない**。この台帳の行をリンクで指し、節ごとの補足だけを書く。
- コードの TSDoc は「INV-NN」を書かず、条件を 1 文で書き、必要ならこの台帳を指す。
