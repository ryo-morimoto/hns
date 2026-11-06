# pi-ai の types.ts との比較

2026-11-07。[pi-ai types.ts](https://github.com/earendil-works/pi/blob/main/packages/ai/src/types.ts) と `packages/core/src/types.ts` を並べる。

## 前提: 層が違う

- pi-ai の `types.ts` は **1パッケージの公開面**。サブモジュール（`api/*`・`providers/*`）の型を再エクスポートし、コアの Message / Model / Provider を定義する。
- hns の `types.ts` は **製品の公開モデル**（API の DTO）。同じ「types.ts」でも、束ねる範囲が違う。

だから「925行 vs 274行」は規模の差であって、設計の優劣ではない。比べるべきは**表現の選び方**。

## 数値

| | pi-ai | hns core |
| --- | --- | --- |
| 行数 | 925 | 274 |
| export | 86 | 48 |
| JSDoc 行 | 174 | 19（Produced by / Consumed by） |
| readonly | 4 | 1（Brand） |
| brand | 0 | 10 |
| 判別可能ユニオン | Message / StopReason ほか | Message / MutationResult / SandboxStatus |

## 同じ選択をしているもの

- **Message は role の判別可能ユニオン**。`Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage`。
- **JsonValue を自前で持つ**（`readonly JsonValue[]` + `JsonObject`）。
- **列挙は閉じた union**（StopReason など）。

## 違う選択

### 1. Message が運ぶもの

pi の `AssistantMessage` は `api`・`provider`・`model`・`usage`・`stopReason`・`durationMs`・`timestamp` を持つ。履歴・課金・デバッグが同じ型で済む。

hns の `Message` は `text` と `toolCalls` だけ。UI 表示には足りるが、**実行履歴・所要時間・モデル**を出せない。出すなら型に足す必要がある。

### 2. 時刻と ID

pi は `timestamp: number`（Unix ms）と `toolCallId: string`。単位はコメントで補う。**brand は使わない**。

hns は `IsoDateTime` / `ProjectId` などの brand。DB・API・UI で同じ `string` が流れるので、取り違えを型で止められる。代わりに境界でキャストが要る。

**どちらが正しいというより、層の違い**。プロトコルをそのまま写す pi には brand の利点が薄い。自前の DB と API を持つ hns には効く。

### 3. 拡張のしかた

pi は外部の列挙を開く: `Api = KnownApi | (string & {})`、`ProviderId = KnownProvider | string`。

hns の `EventName` は閉じた 33 個。イベントは内部の語彙なので、**足したら型を直す**のが正しい。外部の Provider 名を扱うときは pi 流の開き方を使う。

### 4. 型レベルの計算

pi は `IsJsonCompatible<T>` / `JsonRepresentation<T>` で「JSON にできる details だけ受ける」を型で強制する。

hns は `Event.detail: JsonValue` まで。イベントごとに detail の形を分けるなら、同じ手法が使える（今は不要）。

### 5. 設定の厳しさ

pi は `strict: true` だが `exactOptionalPropertyTypes` は使わない（`?:` のみ）。hns は有効なので `?: T | undefined` と書く。区別は正確だが、**表記が重い**。維持するかは判断。

## 学ぶこと

1. **types.ts は「公開面」に使える**。分割後は `types.ts` がサブモジュールの型を再エクスポートする入口になる（pi と同じ）。
2. **単位と意味を JSDoc に書く**（"Unix timestamp in milliseconds"、"subset of output"）。とくに `duration_ms`・`cost`・`totalTokens`。
3. **外部の列挙は開き、内部の列挙は閉じる**。
4. **JsonValue の配列は readonly** にする（反映済み）。
5. **Message のメタデータ**（model・usage・stopReason・durationMs）を出すかは UI 次第。実行履歴を出すなら必要。

## 学ばないこと

- 925行の単一ファイルを製品全体に持ち込むこと。pi は「1パッケージの公開面」だから成立している。
- 条件型の多用。必要になった箇所だけ。

## 判断が要ること

- `Message` に `timestamp` / `model` / `usage` を足すか（実行履歴を出すか）。
- `exactOptionalPropertyTypes` を維持するか（`| undefined` のノイズと引き換え）。
- brand を絞るか（`ProjectId` と `ConversationId` だけ、など）。
