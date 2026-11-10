# 0050: SSE の token / tool イベント

> 0159（ライブ更新の WS 化）に置き換え（D047）。着手しない。

status: superseded
depends-on: 0037, 0046
touches: packages/core/src/http.ts, packages/core/src/http-schemas.ts, packages/core/test

## Goal

会話のトークンとツール実行を SSE で流せるように、core のイベント契約を広げる。

## Acceptance criteria

- [ ] `SSE_EVENT_NAMES` に token / tool を追加し、state と同じ形で schema を持つ
- [ ] parse のテスト（正常・未知イベント拒否）
- [ ] 既存の state イベントは維持
- [ ] server と web が同じ型を使う

## Notes

- いまは state だけ。0035 の受け入れ条件に必要。
- イベントの粒度（token ごと / まとめて）はここで決める。

## やらないこと

- web の描画（0036）。
- 進捗の保存（0039）。
