# 決定：Pi Durable 1.5.0 を固定し、ExecutionEnv を境界にする

- 状態: **採用（暫定）**。ユーザー承認待ち
- 日付: 2026-11-06
- 判断の責任者: 未定（ユーザー）
- 関連: [調査01](../research/01-pi-durable-1.5.0-executionenv.md)、[Workspace Execution Contract v0.1](../design/workspace-execution-contract-v0.1.md)、要件v0.3 U-02

## 文脈

要件v0.3 は「Agent Runtime に Pi Durable を第一候補とし、ExecutionEnv を境界にする」を設計仮説としていた。
2026-11-06 に次を実測した。

- `ExecutionEnv` は FileSystem + Shell で、**条件付き書き込みを持たない**（`writeFile` に版の引数が無い）。
- `renameFile` はあるが、`writeFile` はインプレース。ツールの直列化はプロセス内限定で、`bash` とは競合しない。
- 適合テストは公開されており、pi-env daemon 経由で **29/29 合格**した。
- Durable は README で「Experimental。リリース間で API が予告なく変わる」と明記している。

つまり「Durable に任せれば安全」ではなく、**安全の一部はこちらの層で作る**必要がある。

## 選択肢

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| A | 1.5.0 を exact pin し、Workspace 層で条件付き書き込みを実装 | 上流を追従しやすい。境界が明確 | 二重の層。上流 API 変更に弱い |
| B | Durable をフォークし、`writeFile` に expectedVersion を足す | 一箇所で守れる | フォーク維持。上流追従が重い |
| C | Durable を使わず、Agent Loop を自作 | 完全に制御できる | 永続化・再開・Task Graph を再実装。要件と矛盾 |

## 決定と理由

**A を採用する（暫定）。**

- 要件v0.3 の「Build vs Buy」に沿い、Agent Loop と永続化は借りる。
- 条件付き書き込みは**プロダクト固有の差分**であり、Workspace 層に置くのが責務として自然（ADR-001 の分割とも一致）。
- フォークは、上流が実験段階で変化が速い現時点では維持コストが読めない。

具体的には:

- `@earendil-works/pi-durable` / `pi-env` / `pi-ai` を **1.5.0 の exact pin** にする。
- Tool は `api.env`（`ExecutionEnv`）越しにファイルへ触る。Durable の内部 Storage や実装クラスには結合しない。
- 条件付き書き込み・Journal・イベントは Workspace 層に置き、ExecutionEnv は「素のファイル/コマンド」として使う。

## 結果

得られること:

- 上流の改善をそのまま取り込める。境界が `ExecutionEnv` なので差し替え・遠隔化が可能。
- 安全要件（INV-03/04）を、上流のリリースサイクルと独立に実装・検証できる。

受け入れる制約:

- 「ファイル書き込みの安全性」の責務が2層に分かれる。境界のテストが必須。
- 上流 API の破壊的変更に追随するコストを負う（版固定と適合テストで検出する）。
- Durable の組み込み `write`/`edit` ツールは、そのままでは条件付き保存を満たさない。**本番の Agent には使わせない**か、独自 Tool に置き換える。

## 変更するとき

影響するコード: Tool 登録、ExecutionEnv アダプタ、Workspace 層、Journal、受入試験。
影響するデータ: Workspace の版・Journal。Agent の会話履歴（Durable Storage）は独立。
外部への作用: ファイル書き込み、Worker へのコマンド実行。
戻せる範囲: 版の再固定は容易。Journal のスキーマ変更は移行が必要。

## 見直し

次のいずれかが起きたら再検討する。

- 上流が条件付き書き込み（expectedVersion / CAS）を提供した → B の必要が消えるため A の実装を薄くする。
- 1.6 以降で `ExecutionEnv` の破壊的変更が出た → 適合テスト（T-01）で検出し、追随か固定継続かを決める。
- Workspace 層のオーバーヘッドが実用上無視できないと測れた → フォーク（B）を比較する。
- 要件#2（複数マシン）の解釈が「各マシンで Core Agent」に確定した → 配置の前提が変わるため、ADR-001 と合わせて再判定する。
