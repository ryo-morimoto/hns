# WASM でエディタを速くできるか（スパイク）

2026-11-06 / **Want**。今は採用しない。判断材料だけ残す。
コード: `work/poc/wasm-editor`（`node run.mjs` で再現、`results.json` に数値）

## 問い

Zed 相当の編集体験を Web で出すとき、WASM は速度と可用性を上げるか。
上がらないなら、通信（リアルタイム性・パケット）の最適化は要るか。

## 測ったもの

| 項目 | 結果 |
| --- | --- |
| パース（318KB / 4,000行、acorn = 純JS） | acorn 99ms / `@swc/wasm` 90ms（parse + transform + codegen）。初期化 29ms |
| tree-sitter WASM | **動かない**。`web-tree-sitter` 0.27.1 と `tree-sitter-wasms` 0.1.13 の ABI 不一致 |
| 1編集イベント（JSON / MessagePack） | 151B / 129B（−15%） |
| 50件バッチ | 7.5KB / 6.5KB |
| 全量スナップショット（214KB） | JSON 218KB / MessagePack 214KB（−2%） |
| CRDT（Yjs）2,000編集 | 合計 262KB、**1編集 131B**。毎回全量なら 427MB |
| batching（RTT 20ms） | 逐次 50 ops/s → 10件まとめ 500 ops/s |

## 分かったこと

1. **描画は WASM の領域ではない**。Zed の速さは GPUI（native）由来で、Web では JS / Canvas のまま。
2. **パースの伸びは小さい**（1.13x）。エディタの常時コストは差分ハイライトで、本命の tree-sitter は
   grammar のビルド（emscripten）と版固定が要る。今日は ABI 不一致で動かなかった ＝ **可用性のリスクが実在**。
3. **通信は符号化より送り方**。MessagePack は 15% 減るだけ。効くのは patch 化と batching（10倍）。
4. **CRDT は効く**。1編集 131B、全量保存の 1/1,600。リアルタイム・オフラインの土台になる。

## 判定

**後回し。** MVP（会話→編集→差分→再開）には不要で、WASM 化の効果は限定的。ツールチェーンの不安定さだけ先に負う。

## 再開条件

- 共同編集・リアルタイム共有が要件になった（→ CRDT を `EditorBuffer` の下に入れる）。
- 遠隔編集の RTT が体感を壊すと測れた（→ patch + batching + MessagePack へ）。
- tree-sitter の grammar を固定版でビルドでき、CI に載った（→ 差分ハイライトに使う）。

## もしやるなら

1. CRDT（Yjs）をバッファの下に入れる。今の状態機械（dirty / conflict）はそのまま使える。
2. イベントを patch + batching に変える。NDJSON 全量を置き換える。
3. tree-sitter は `web-tree-sitter` と grammar の版を固定し、wasm を CI でビルドする。
