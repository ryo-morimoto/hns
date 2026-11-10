# 0143: 秘密の配置（gateway・git はマシン・DEK）

status: open
priority: now
depends-on: 0140
touches: docs/auth.md

## Goal

どの秘密をどこに置くかを決め、「エージェントループのコードと同じ信頼領域に鍵を置かない」を原則にする。

## Acceptance criteria

- [ ] 表: provider 鍵 / git・gh の資格情報 / webhook token / DEK / マシンのデバイス鍵 の置き場所
- [ ] provider 鍵は gateway Worker のみが持ち、harness の isolate には置かないと明記
- [ ] provider 側の支出上限と、gateway の緊急停止を要件に入れる
- [ ] DEK は包んだまま DO、平文は端末だけ（D019 の維持）
- [ ] sandbox の hide（0052）を MVP の前提条件に格上げ
- [ ] 漏洩時の封じ込め手順（キー失効 → ローテーション）を1ページで書く

## Notes

- 手元に鍵を置く案は、この製品では安全側にならない。エージェントが bash を実行するマシンであり、0052 が未配線のあいだは特にそう。
- git はマシンで動くので、資格情報を Cloudflare に渡さない。

## やらないこと

- gateway の実装（0151）。
- passkey の実装（0158）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
