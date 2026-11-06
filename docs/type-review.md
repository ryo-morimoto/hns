# 型レビューの見方

2026-11-07。`packages/core/src/types.ts` を厳しく見るための観点と前提知識。

## 前提知識

- **型は「値の集合」**。レビューは「この型に属する値を、誰が作れて、誰が読むか」を追う作業。
- **表現できない不正状態を作る**のが目的。条件分岐（if role === ...）が型で消せるなら、型が足りない。
- **型は実行時を守らない**。JSON は何でも来る。いまは zod を外しているので、「誰が実行時に確かめるか」を型ごとに言えること。
- **境界は3つ**: DB の行、JSON の往復、UI の状態。それぞれ表現が違う（Date・undefined・Map は JSON で消える）。
- **名前的型（brand）**: `string` は何にでもなる。ID と日時と版は brand で取り違えを防ぐ。
- **判別可能ユニオン**: `status` や `role` で分け、`switch` の `never` で網羅を強制する。
- **optional と null は違う**: 無い（キーが無い）・null（値が無い）・""（空）を混ぜない。`exactOptionalPropertyTypes` で区別する。
- **構造的部分型**: 形が合えば通る。余計なプロパティは代入時だけ検査される（excess property check）。境界では `satisfies` と明示的な組み立てを使う。

## レビューの手順

1. **値を列挙する**: 型ごとに「実際に来る値」を3つ書く（正常・境界・異常）。書けないなら型が曖昧。
2. **不正状態を探す**: 同時に成立してはいけない組み合わせが、型で表現できてしまうか。
3. **`string` / `number` / `boolean` を疑う**: それは ID か、日時か、列挙か、単位付きの数か。
4. **optional を疑う**: 無いことに意味があるか。ロールで変わるならユニオンに分ける。
5. **保存形式の漏れを探す**: `archived: number`（0/1）、DB の連番 ID、snake_case と camelCase の混在。
6. **不変性**: 返した配列やオブジェクトを、読む側が書き換えてよいか。`readonly` を検討する。
7. **完全性**: 実装・API・画面に出る概念が型にあるか（Workflow・Automation・Run など）。
8. **拡張時の影響**: 列挙に1つ足したとき、どこがコンパイルエラーになるか。ならないなら弱い。
9. **単位と命名**: `*Ms`・`*Bytes`・`*Usd`。snake_case は JSON、camelCase は TS か、どちらかに寄せる。
10. **型のテスト**: `expectTypeOf` / `tsd`、`@ts-expect-error` で「通ってはいけない形」を固定する。

## このファイルへの適用（見つけたもの）

| 重大度 | 箇所 | 問題 | 直し方 |
| --- | --- | --- | --- |
| 高 | `Message` | `role` と optional の組合せで不正状態が作れる（user に toolName、tool に text 無し） | 判別可能ユニオン（user / assistant / tool）に分ける |
| 高 | `Conversation.archived` | DB の 0/1 が API に漏れている | `boolean` にし、境界で変換 |
| 高 | `Health.auth` | `string`。`AuthMode` があるのに使っていない | `AuthMode` にする |
| 高 | `ChatResponse.submissionId` | DB の連番。外に出す ID ではない | 不透明な `SubmissionId`（brand）に |
| 中 | 全体 | ID が `string`。`project_id` と `conversationId` を取り違えても通る | brand（`ProjectId` など）と生成関数 |
| 中 | 日時 | `created_at` 等が `string`。形式・TZ が不明 | `IsoDateTime` brand。`updated_at` は「未設定」の意味を決める |
| 中 | `Event.event` / `TaskView.kind·state` / `State.scheduling` | 閉じた集合なのに `string` | 既知の union（必要なら `(string & {})` で拡張可） |
| 中 | `FileWriteRequest.expectedVersion` | `"absent"` の特別扱いが型に出ていない | `FileVersion \| "absent"` |
| 中 | `MutationResult.unknown.reason` | `string`。実際は `"io"` だけ | `"io" \| "crash" \| "timeout"` |
| 中 | `SandboxStatus` | `available` と optional の組合せが不正 | true の形と false の形のユニオン |
| 中 | `Health.version` | 定数 `1`。意味が無い | サーバの版（semver）にするか削除 |
| 中 | `State` | 会話・プロジェクトの全件を状態に同梱 | 要約（件数）か別 API。件数上限を型で示す |
| 中 | `FileRead.content` / `FileWriteRequest.content` | 文字列の意味（UTF-8 か base64 か）が不明 | テキストに限定するか `Uint8Array` の表現を決める |
| 低 | `Metrics` / `Usage.today` | `{ turns; tokens; cost }` の重複 | `TokenTotals` に切り出す。`chats` のキーも union に |
| 低 | 命名 | `created_at` と `conversationId` が混在 | JSON は snake_case に統一（または camelCase に全て寄せる） |
| 低 | 不変性 | 配列・オブジェクトが可変 | 返す側は `readonly` を検討 |
| 低 | 完全性 | Workflow / Automation / Firing / Run の型が無い | 実装に合わせて追加 |

## 型をテストする

- `expectTypeOf`（vitest）や `tsd` で「代入できてはいけない」を固定する。
- `@ts-expect-error` を「不正な状態の見本」として置く（消えたら気づける）。
- 実データのフィクスチャを `satisfies` で受ける（型と実物のズレを一度は目で見る）。
## 反映（2026-11-07）

高・中を `types.ts` に反映した。

- `Message` → 判別可能ユニオン（user / assistant / tool）。`timestamp` を全員に、`model` と `usage` を assistant に追加（実行履歴）。
- `Conversation.archived` → `boolean`、`Health.auth` → `AuthMode`、`Health.version` → `ServerVersion`。
- brand は **`ProjectId` と `ConversationId` だけ**。日時・その他の ID・版は `string`（ISO 8601 などは JSDoc に書く）。
- `Event.event` → `EventName`、`TaskView.state` → `TaskState`、`State.scheduling` → `Scheduling`。
- `expectedVersion` → `FileVersion | "absent"`、`MutationResult.unknown.reason` → `"io" | "crash" | "timeout"`。
- `SandboxStatus` を判別可能ユニオンに。
- `State` は件数（`counts`）だけを持ち、一覧は別 API に。
- ファイルの中身は UTF-8 テキストと明記。

境界では brand を作る必要がある（`value as ProjectId`）。キャストは SAFETY コメント付きで、DB の行を読む場所に閉じ込める。

残り（低）: 命名の統一（snake_case と camelCase）、`readonly`、`Metrics` の重複、Workflow / Automation / Run の型。