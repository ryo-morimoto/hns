# 0049: agent の複数会話 API

status: open
priority: plan
design: pending
depends-on: 0034, 0046
touches: packages/agent/src, packages/agent/test

## Goal

server が複数会話・workflow ノード・usage / inspect を扱えるように、agent の公開 API を広げる。

## Acceptance criteria

- [ ] 会話の作成・取得（root 以外）と ownerless 会話
- [ ] usage と inspect（tasks / queued / scheduling）
- [ ] 送信・中断・transcript が会話単位
- [ ] 既存の `openAgent` とテストは維持
- [ ] server が pi-durable を直接 import しなくて済む

## Notes

- いまは `openAgent` が1会話だけ。server が Harness を直接触ると境界が崩れる。
- storage は呼び出し側（server）が注入する。

## やらないこと

- Model アダプタの追加。
- hooks / events の拡張（0039）。
