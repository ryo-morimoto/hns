# 0273n: audit-probe の `v1` の assert が 0.84% で落ちる

status: open
priority: now
design: agreed
design-ref: lead が 2026-11-19 に実測
depends-on: —
touches: packages/server/src/do/audit-probe.test.ts

## Intent

`packages/server/src/do/audit-probe.test.ts:126` の

```
expect(JSON.stringify(body)).not.toContain("v1")
```

が、**ランダムな callId の 12 文字の接尾辞（`tool:…:iu0w8unyv1b`）が偶然 `v1` を含むと落ちる**。
**lead の実測**: その接尾辞が `v1` を含む確率は **約 0.84%**（100 万回で 8,439 件）。**base（8df287b）で 10 回 + server 全体 2 回では再現しなかった**が、**確率から 20 回に 1 回弱**と分かる。

**0237 のレーンがこの flake を「自分のせいかも」で 1 時間止まった**。以後のレーンも同じ疑いで止まるので、直す。

## Acceptance

- [ ] `not.toContain("v1")` を、**「値が v1 形式（先頭が `v1`）でない」を確かめる assert** に置き換える（`JSON.stringify` の全体を検索しない）
- [ ] **確率的に落ちない**ことを、**1000 回のループ**か**固定の乱数**で示す
- [ ] 何を守っているのかを **TSDoc / コメント**に書く（本文・セル値が載らないこと）

## Log

- 2026-11-19: lead が実測で確定。0237 の Result に「本 issue のせいではない」と記録済み。
