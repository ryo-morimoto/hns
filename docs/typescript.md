# TypeScript 実践（golden example 準拠）

2026-11-07。5つの実在プロジェクトを基準に、TypeScript で壊れにくいコードを書くための知識をまとめる。**指示ではなく、参照元のコードを根拠にする。**

## 参照元

| リポジトリ | 見るファイル | 学ぶこと |
| --- | --- | --- |
| Trigger.dev | [`internal-packages/run-engine/AGENTS.md`](https://github.com/triggerdotdev/trigger.dev/blob/main/internal-packages/run-engine/AGENTS.md) | 失敗前提の実行管理。状態・ロック・リトライ・checkpoint・testcontainers |
| Medusa | [`workflows-sdk/src/utils/composer/create-step.ts`](https://github.com/medusajs/medusa/blob/develop/packages/core/workflows-sdk/src/utils/composer/create-step.ts) / [`create-workflow.ts`](https://github.com/medusajs/medusa/blob/develop/packages/core/workflows-sdk/src/utils/composer/create-workflow.ts) | step の invoke / compensate、workflow の合成、モジュール分離 |
| Twenty | [`CLAUDE.md`](https://github.com/twentyhq/twenty/blob/main/CLAUDE.md) | 日常の規約。type 優先・literal union・named generic・guard の再利用 |
| Payload CMS | [`fields/validations.ts`](https://github.com/payloadcms/payload/blob/main/packages/payload/src/fields/validations.ts) | 境界での検証。`test/<feature>/{config,int.spec,e2e.spec}.ts` の3層テスト |
| Effect | [`Schema.ts`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Schema.ts) / [`Layer.ts`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/Layer.ts) | `decodeUnknown` による境界検証、型付きエラー、依存の合成 |

## 1. 境界で parse する（全5プロジェクトがやっている）

型は実行時を守らない。外部から来る値（HTTP ボディ、DB の行、JSON、環境変数）は `unknown` として受け、**検証してから**型付きにする。

- Payload はフィールドごとの `validate` 関数を持ち、失敗を**値**（`true | string`）で返す。例外にしない。
- Effect は `Schema.decodeUnknownSync(UserId)("user_123")` のように、スキーマで `unknown` を型付きに変換する。
- Trigger.dev は実行前にジョブのペイロードを検証する。

```ts
// ❌ 検証していない
const project = JSON.parse(body) as Project;

// ✅ 検証してから型にする
const project = parseProject(JSON.parse(body)); // 失敗したら throw か Result
```

**`as` は検証ではない。** `satisfies` も検証ではない（コンパイル時の検査だけ）。境界では必ず実行時の検査を通す。

## 2. 状態を型で表す（Medusa / Trigger.dev）

Medusa の step は **invoke と compensate を対**で持つ。失敗したら補償を実行する、という業務の性質が型に出ている。

```ts
type CompensateFn<T> = (input: T | undefined, context: StepExecutionContext) => unknown
```

Trigger.dev は run を `RunAttempt`・`Checkpoint`・`Waitpoint` のような**状態と遷移**に分ける。

- 状態は判別可能ユニオン（`{ kind: "running" } | { kind: "waiting"; on: ... } | ...`）
- 遷移は1箇所（engine）に集める
- 途中状態を永続化する（crash から戻れる）
- 同じ処理を2回実行しても壊れない（冪等性キー・ロック）

**不正な状態を型で作れなくする**のが目的。`status: string` はその逆。

## 3. 失敗を型で表す（Effect / Trigger.dev）

Effect の `Effect<A, E, R>` は「成功 A・失敗 E・依存 R」を型に持つ。失敗が**型に出る**ので、呼び出し側が処理を強制される。

- 想定内の失敗: 型付きの E
- 想定外の欠陥: defect（別チャネル）
- リトライ: 失敗の種類で決める（Trigger の retry 設定）

**at-least-once が前提。** リトライされるなら、副作用は冪等にする（同じキーで2回書いても1回と同じ結果）。

## 4. 依存は端で組み立てる（Effect Layer / Medusa container / NestJS）

Effect の `Layer<ROut, E, RIn>` は「何を提供し、何を要求し、どんな失敗があるか」を型で表す。アプリの入口で1回だけ組み立てる。

- 依存はインターフェース（型）で受ける
- 実装の差し替えは composition root だけ
- テストではテスト用 Layer を渡す

モジュールのグローバル変数や、import した瞬間に接続するシングルトンは避ける。

## 5. 型の書き方（Twenty の規約が簡潔）

Twenty の [`CLAUDE.md`](https://github.com/twentyhq/twenty/blob/main/CLAUDE.md) から、実務で効くもの:

- **`type` を優先**（第三者の interface を拡張するときだけ interface）
- **enum より string literal の union**（GraphQL enum を除く）
- **`any` 禁止**。`unknown` から検証して絞る
- **generics は説明的に**（`T` ではなく `TData`）
- **既存の guard を再利用**（`isDefined` / `isNonEmptyArray` / `isPlainObject`）
- 省略名を使わない。定数は SCREAMING_SNAKE_CASE、props 型は `Props` 接尾辞
- 名前付き export

補足（一般的な知識として）:

- `interface` と `type` に性能差はない。差は拡張・合流・union の表現力
- `as const` は literal を保つ。`satisfies` は「型を満たすか検査しつつ推論を保つ」
- `exactOptionalPropertyTypes` は「無い」と「undefined」を区別する。JSON では区別が消えるので、境界の設計とセットで決める

## 6. フロントとバックエンドの境界（Twenty）

Twenty は `twenty-shared` に同型の型と util を置き、`twenty-front`（React + Jotai）と `twenty-server`（NestJS + GraphQL）が共有する。

- ワイヤーの型は共有パッケージへ。サーバの内部型をクライアントに import させない
- サーバ状態（GraphQL/React Query）とクライアント状態（Jotai）を混ぜない
- レスポンスはクライアントでも検証する（信用しない）

## 7. テスト（Payload / Trigger / Medusa）

Payload のテストは機能ごとに3層:

```
test/<feature>/config.ts     # フィクスチャ（コレクション定義など）
test/<feature>/int.spec.ts   # 実 DB + API の統合
test/<feature>/e2e.spec.ts   # ブラウザ
```

Trigger.dev は **testcontainers** で PostgreSQL と Redis を立て、engine を実物で試す。Medusa は `packages/modules/integration-tests` でモジュールを実 DB に対して試す。

- 永続化のテストはモックしない（SQL・トランザクション・制約を試す）
- 失敗経路（リトライ・補償・重複実行）をテストする
- フィクスチャは決定的に。時刻・ID は注入する

## 8. よくある誤解

| 誤解 | 実際 |
| --- | --- |
| `as` で型を付けられる | 実行時は何も起きない。検証ではない |
| `satisfies` で安全になる | コンパイル時だけ。入力の検証にはならない |
| `any` は便利 | 型検査が伝播して消える。`unknown` + 検証が正しい |
| interface の方が速い | 性能差はない |
| enum が安全 | 実行時オブジェクトを持つ。literal union で足りる |
| optional と null は同じ | 「無い」「null」「空」は別。`exactOptionalPropertyTypes` で区別できる |
| 構造的部分型は安全 | 余計なプロパティは literal のときしか検査されない |
| 配列は共変で安全 | `string[]` を `(string | number)[]` に入れると実行時に壊れる |
| 型レベル計算はすごい | アプリコードでは可読性を落とす。ライブラリの仕事 |

## 9. レビューのチェックリスト

- 外部入力はすべて parse しているか（HTTP・DB・JSON・env）
- `as` が信頼できない値に付いていないか
- union の `switch` は `never` で網羅しているか
- 失敗は型に出ているか。想定内と欠陥が分かれているか
- 状態遷移は1箇所か。途中状態は永続化されるか
- リトライされる副作用は冪等か
- 依存は入口で組み立てているか。テストで差し替えられるか
- 永続化のテストは実 DB か。モックで済ませていないか
- ストレージの型（0/1、snake_case、JSON 文字列）が外に漏れていないか
- クライアントがサーバの内部型を import していないか

## 10. hns への適用（率直な差分）

いまの hns は **型だけ**を持ち、境界の parse を持たない。これは golden example のどれとも違う。

- 5つとも、外部入力の検証を必ず持つ。Payload は validate、Effect は Schema、Trigger は payload 検証、Medusa は workflow 入力の型と実行時検査、Twenty は GraphQL の入力型
- `parseProject(row)` は列挙の検証はするが、行の他のフィールドは検証していない。**本物の parse ではない**
- 型を先に書くこと（type first）と、境界で parse することは両立する。型はモデル、parse は入口。

推奨: HTTP の入口と DB の読み出しに parse を置く。zod を使わないなら手書きの guard でもよいが、**検証を省かない**。
