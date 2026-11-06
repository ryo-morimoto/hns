# Coding standards

コードを書く・レビューするときに頭に置く規約。ここには要点だけを書き、理由の詳細はリンク先に置く。

## 型

### モデルが正本

`packages/core/src/types.ts` がモデル。型を先に書き、schema は境界の検証として後から合わせる。
schema が型に合わなければコンパイルが落ちる（`v.GenericSchema<unknown, T>`）。型を schema から逆算しない。
→ [engineering.md](docs/engineering.md) §3

### `any` は漏れる

`any` はその値を通るすべての検査を切る。未知は `unknown` で受け、parse して型にする。
第三者の型が本当に `any` のときだけ、境界で1回キャストして名前付きの型に閉じ込め、公開シグネチャに出さない。

### `as` には根拠が要る

`as` は実行時に何もしない。信頼できない値に付けない。やむを得ない境界では、直前に `// SAFETY:` で不変条件を書く。
Enforced: `anti-slop/require-safety-comment-for-type-assertion`

### optional・`null`・「無い」は別

`?:` は「キーが無い」、`null` は「値が無い」。DB と JSON で意味が違うので混ぜない。
`exactOptionalPropertyTypes` を有効にし、`?: T | undefined` と明示する。

### brand は取り違えの実例があるときだけ

同じ primitive の値が同じスコープで交差し、取り違えると壊れる境界にだけ付ける。**固定リストにしない。**
増やすときは「どの取り違えを防ぐか」を言えること。現在の例: `ProjectId` / `ConversationId`。
→ [type-review.md](docs/type-review.md)

### union は閉じ、`switch` は網羅する

状態・イベントは const array 由来の union。`switch` は全メンバーを `case` に書き、`never` で網羅を強制する。
`default` で残りを吸わない（新しいメンバーが無言で fallback に落ちる）。

## 検証

### `unknown` は parse するまで `unknown`

HTTP のボディ、DB の行、環境変数、JSON は外部。境界で1回 parse し、内側では型を信じる。
parse せずに `as` で型にしない。`satisfies` も実行時の検証ではない。

### 保存表現を外に出さない

`archived: 0 | 1`、JSON 文字列、連番は store の内側。公開型に parse してから返す。
→ [packages.md](docs/packages.md)

### schema は型に適合させる

`v.GenericSchema<unknown, T>` で型に縛る。schema を先に書いて型を後から作らない（型が正本）。
不一致はコンパイルエラーになる。

### 不正な保存値は黙って通さない

列挙外・欠損は throw する（valibot の `ValiError`）。既定値に倒さない。壊れた行は表面化させる。

## エラー

### 想定内の失敗は型に出す

API の失敗は `ErrorCode` の union（`invalid_request` / `unauthorized` / `not_found` / `conflict` / `rate_limited` …）。
文字列の `error` を増やさない。呼び出し側が分岐できる形にする。
→ [decisions.md](docs/decisions.md) D031

### `Error` を投げる

文字列や plain object を throw しない（stack と `instanceof` が消える）。想定外は `Error` のサブクラス。

### 握りつぶさない

空 catch を書かない。待つか、理由を書いて `void` にする。想定した種類だけ catch し、それ以外は通す。

## 安全

### 秘密はリポジトリとログの外

鍵は `~/.config/hns/` に置く。イベントログに body・header・token を残さない（path と status だけ）。
→ [observability.md](docs/observability.md)

### 認可は境界で

UI の表示やクライアントが送った id を信じない。変更系は境界で認可し、所有者を確認する。
→ [auth.md](docs/auth.md)

### 信頼しない入力

パスは正規化して root 内を確認する。コマンドは sandbox（bubblewrap）経由で実行する。
sandbox が使えない環境では exec を提供しない。
→ [safety.md](docs/safety.md)

### fail closed

認証・sandbox・root の同一性は、確認できなければ拒否する。
