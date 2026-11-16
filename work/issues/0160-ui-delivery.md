# 0160: UI の配信（Workers Assets・typed client）

status: open
priority: plan
design: pending
depends-on: 0159
touches: packages/web/, deploy/assets/

## Goal

UI を Worker から配信し、typed client を WS と組み合わせる。0036・0100 系の前提をこの形に合わせる。

## Acceptance criteria

- [ ] 静的アセットを Workers Assets で配信（キャッシュ規則を決める）
- [ ] typed client は 0037 の契約から生成し、WS は別の口として持つ
- [ ] 独自ドメインを付けるか workers.dev にするかを決める
- [ ] 未認証時のリダイレクトを 0145 と一致させる
- [ ] XSS の面を確認（UI から exec に届くため、0158 / 0165 と突き合わせる）

## Notes

- PoC は run.mjs だけで UI を持たない。
- 0103〜0114 の画面はこの配信形態の上で作る。

## やらないこと

- 画面そのもの（0103〜0114）。
- Grabber（要件11）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
