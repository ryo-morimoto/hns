# 0010: WASM エディタ（Want）

status: open
priority: parked
design: pending
depends-on: —
touches: work/poc/wasm-editor, work/research/wasm-editor.md

## Goal

Web のエディタを WASM で速くできるか、通信を最適化する必要があるかを測る。

## Acceptance criteria

- [x] パース速度を測る（純JS vs WASM）
- [x] メッセージ量を測る（JSON / MessagePack / CRDT）
- [x] 安定性を判定する

## Result

**後回し**。WASM の利点は限定的（parse 1.13x）で、tree-sitter は ABI 不一致で動かない。
CRDT と batching は効果あり（1編集 131B、RTT 20ms で 10倍）。
再開条件は [research](../research/wasm-editor.md)。
