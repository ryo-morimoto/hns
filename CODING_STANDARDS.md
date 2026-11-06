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

## 境界の検証

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
## テスト

- 永続化はモックしない。実 SQLite（`:memory:` か一時ファイル）で試す。
- **回帰を1行で言えないテストは足さない。** 言えるなら `// Catches: <bug>` を書く。
- 失敗経路（不正入力・遷移違反・競合）をテストする。実装の詳細（文言・内部関数）に結合しない。
- 新しいテストが実際に実行されることを確認する（`node --test` + 型ストリップ、パッケージ間は `--conditions=source`）。

## コメント

- 書くのは **WHY だけ**。何をしているかはコードが言う。2〜3行、最大5行。
- 長い説明は module docstring・README・decisions に置き、コメントは1行の参照にする。
- 同じ事実を複数箇所（Dockerfile・manifest・コード）に書かない。

## パッケージと依存

- 依存は一方向。許可される辺と型の置き場所は [packages.md](docs/packages.md)。
- 公開面は `exports` で絞る。内部型を外に出さない。
- 新しい依存は、なぜ要るかを decision に1行残す。exact pin。標準で足りるなら足さない。
- 静的 import を優先。循環・コード分割・条件付き読み込みのときだけ動的 import。

## チェック

- `npm run check` がゲート（pre-commit でも走る）。**build は配布物が壊れていないことの確認で、正しさの証明ではない。**
- 正しさは型とテストで示す。テストを足さない変更は、なぜ不要かを言う。
- 既存の guard・helper・エラー型を探して使う。再実装は最も多い AI の欠陥。
- 新しい抽象化は、利用箇所が2つ以上になってから。

## 周囲のコード

- 隣のファイルの書き方（命名・構成・コメント密度）に合わせる。ただし型・検証・安全の規約はこの文書が優先。
- 使う予定のない抽象化・汎用層を作らない（YAGNI）。
- 生成物は手編集しない（生成ヘッダと再生成コマンドを守る）。
