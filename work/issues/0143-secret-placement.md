# 0143: 秘密の配置（gateway・git はマシン・DEK）

status: in-progress
priority: now
depends-on: 0140
touches: docs/auth.md

## Goal

どの秘密をどこに置くかを決め、「エージェントループのコードと同じ信頼領域に鍵を置かない」を原則にする。

## Acceptance criteria

- [x] 表: provider 鍵 / git・gh の資格情報 / webhook token / DEK / マシンのデバイス鍵 の置き場所
- [x] provider 鍵は gateway Worker のみが持ち、harness の isolate には置かないと明記
- [x] provider 側の支出上限と、gateway の緊急停止を要件に入れる
- [x] DEK は包んだまま DO、平文は端末だけ（D019 の維持）
- [x] sandbox の hide（0052）を MVP の前提条件に格上げ
- [x] 漏洩時の封じ込め手順（キー失効 → ローテーション）を1ページで書く

## テスト条件

- C1: docs-only。置き場所の表・gateway の鍵分離・DEK・hide・封じ込めが、D019 / D047 / D059 と矛盾しない。
- C2: 実装の受入は 0151（gateway の鍵分離・予算・停止）と 0147（hide）が持つ。

## テスト設計

- T1: この issue では文書を review で確認する。コードのテストは 0151 / 0147 で書く。

## Notes

- 手元に鍵を置く案は、この製品では安全側にならない。エージェントが bash を実行するマシンであり、0052 が未配線のあいだは特にそう。
- git はマシンで動くので、資格情報を Cloudflare に渡さない。

## やらないこと

- gateway の実装（0151）。
- passkey の実装（0158）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-10: [docs/auth.md](../../docs/auth.md) に「秘密の配置（0143）」を追加。表・gateway・git の例外・DEK・
  sandbox hide・封じ込め手順。PoC の service/provider は履歴と明記した。
