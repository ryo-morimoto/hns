# 0151: provider gateway（鍵の分離・予算・緊急停止）

status: open
priority: now
depends-on: 0143, 0144
touches: packages/server/src/gateway/, packages/server/test/gateway/, packages/store/src/migrations/, tools/deploy/, work/issues/0151-provider-gateway.md

## Goal

provider の鍵を harness の isolate から切り離す。harness が汚染されても鍵は盗めず、課金だけが上限で止まる形にする。
gateway は **素の Worker**。予算のカウンタは D1 の 1 文で持つ（DO を作らない。D049）。

## Acceptance criteria

- [ ] gateway は「モデル呼び出し」だけを受ける（任意 URL の proxy にしない）
- [ ] 鍵は gateway の secret のみ。harness 側の env に鍵が無いことをテストで固定
- [ ] 日次・月次の上限を D1 の行に持ち、`UPDATE ... WHERE spent < limit` で原子に判定する
- [ ] 超えたら 429。緊急停止フラグは即時 503
- [ ] 鍵のローテーション手順（停止 → 入れ替え → 再開）
- [ ] provider 側の支出上限とアラートの設定手順

## Notes

- PoC には無い（faux provider で鍵を使わない）。
- 手元 proxy 案は採らない（トークンが往復し、pi-ai の transport 差し替えが要る）。
- 被害を「金額」に有界にするのが目的。確率の議論をしない。
- D1 の単一行 UPDATE は原子的なので、DO のカウンタは要らない。書き込み頻度はモデル呼び出し単位。

## やらないこと

- OAuth の更新（0128）。
- 利用量の集計 UI（0163）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-07: 予算カウンタを D1 に変更（D049）。
- 2026-11-17: ユーザーの判断で `plan` から `now` へ昇格。レーン L9。touches を実パス（`store/src/migrations/`）に直し、gateway Worker の配線として `tools/deploy/` を足した。store migration の枠を持つ。
