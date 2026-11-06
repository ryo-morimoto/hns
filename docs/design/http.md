# 設計: HTTP API

ルート・応答・エラーを設計するときに読む。索引は [design.md](../design.md)。

## 一覧は最初からページネーションを入れる

- **条件**: 一覧を返す API を設計するとき。件数が増えうるとき
- **命令**: `page_size` と `page_token`（または同等のカーソル）を最初に入れる
- **補足**: 後から足すと、全件取得に依存したクライアントを壊す。上限と既定値も決める
- **Ref**: [AIP-158](https://google.aip.dev/158)

## safe / idempotent を守る

- **条件**: GET・PUT・DELETE を設計するとき。クライアントがリトライしうるとき
- **命令**: GET は変更しない。PUT / DELETE は再送しても同じ結果にする
- **補足**: POST で作るなら、冪等キーか版で守る
- **Ref**: [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) / [CQS](https://martinfowler.com/bliki/CommandQuerySeparation.html)

## エラーは機械可読にする

- **条件**: エラー応答の形を決めるとき
- **命令**: `type` / `title` / `status` / `detail` / `instance` に寄せる（RFC 9457）。業務コードは別のフィールドに置く
- **補足**: 文字列の `error` を増やさない。呼び出し側が分岐できるコードにする
- **Ref**: [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) / [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558)

## 状態コードを正しく使う

- **条件**: 400 / 401 / 403 / 404 / 409 / 422 / 429 のどれを返すか決めるとき
- **命令**: 次の対応で返す。入力不正は 400、未認証は 401、権限は 403、不在は 404、競合は 409、制限は 429
- **補足**: 「便利だから 200 で失敗を返す」をしない
- **Ref**: [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) / [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)

## リトライできる形にする

- **条件**: クライアントや Automation が再試行しうるとき。ネットワーク越しに書き込むとき
- **命令**: 冪等キーか版で守る。再試行の結果を区別できるようにする
- **補足**: 成功したか分からない失敗を、成功として扱わない
- **Ref**: [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) / [AIP-158](https://google.aip.dev/158)
