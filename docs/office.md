# Office の契約（v1.1）

2026-11-17 / 状態: review（独立レビューの blocking を反映）。決定は D102・D103。
設計の背景は [work/research/office-architecture.md](../work/research/office-architecture.md)。
実装の正本は `@hns/core/src/office.ts`（型）と valibot schema。この文書はその意味と不変条件を持つ。

## 0. 版

- 契約 v1.1（v1 の field 追加 + 状態 1 つ + エラー 3 つ）。破壊的変更は v2。
- machine の wire は既存の `MACHINE_REQUEST_VERSION` に従う（op の追加は後方互換）。

## 1. 範囲

**入れる**: docx / xlsx / pptx のプレビュー（PDF）、PDF への変換、PNG（目視 QA）、inspect（構造の読み取り）、
編集（テキスト・セル・数式）、xlsx の再計算。

**入れない**: ODF / CSV / HTML / 旧形式への変換（D102）、共同編集、ブラウザ内編集、マクロの実行。

## 2. 語彙

```ts
OFFICE_FORMATS = ["docx", "xlsx", "pptx", "pdf"];
OFFICE_OPERATIONS = ["preview", "render", "inspect", "edit", "convert", "recalc"];
PREVIEW_STATUSES = ["unsupported", "disabled", "queued", "generating", "ready", "failed", "stale"];

OFFICE_ERROR_CODES = [
  "unsupported_format",
  "unsupported_command",
  "input_too_large",
  "too_many_cells",
  "too_many_pixels",
  "engine_unavailable",
  "engine_timeout",
  "engine_failed",
  "engine_busy",
  "output_too_large",
  "source_changed",
  "not_authorized",
  "cancelled",
];
```

`OfficeJob` は `operation` を判別子にした閉じた union。`limits` は server がポリシーから解決して載せる。
**モデルは limits を決めない。**

編集の語彙（`edit` の `commands`、v1 は 3 種だけ）:

```ts
export type OfficeCommand =
  | { readonly op: "setText"; readonly paragraphId: number; readonly text: string }
  | { readonly op: "setCells"; readonly sheet: string; readonly cells: readonly CellEdit[] }
  | {
      readonly op: "setShapeText";
      readonly slide: number;
      readonly shape: number;
      readonly text: string;
    };

export interface CellEdit {
  readonly ref: string; // "B12"
  readonly value:
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "number"; readonly value: number }
    | { readonly kind: "formula"; readonly formula: string }; // "=SUM(B2:B9)"
}
```

```ts
interface OfficeInput {
  readonly workspaceId: string; // workspace の同一性（machine の ROOT と 1:1）
  readonly path: string; // workspace 相対
  readonly version: string; // workspace の版。実体は "sha256:<hex>"（内容ハッシュ）
  readonly format: OfficeFormat;
}

// operation が判別子。op の違う option を混ぜた job（preview + commands）は schema が拒否する。
type OfficeJob = {
  readonly v: 1; // 契約の版。破壊は v2
  readonly id: OperationId; // [A-Za-z0-9_-]{1,64}。監査（§7）と冪等な再試行が同じ id を名乗る
  readonly input: OfficeInput;
  readonly limits: OfficeLimits; // server がポリシーから解決して載せる（§10）
} & (
  | {
      readonly operation: "preview";
      readonly pages?: readonly (number | { from: number; to: number })[];
    }
  | {
      readonly operation: "render";
      readonly pages?: readonly (number | { from: number; to: number })[];
      readonly width?: number;
    }
  | { readonly operation: "inspect" }
  | { readonly operation: "edit"; readonly commands: readonly OfficeCommand[] }
  | { readonly operation: "convert"; readonly to: "pdf" }
  | { readonly operation: "recalc" }
);

type OfficeResult =
  | { readonly ok: true; readonly artifact: OfficeArtifact; readonly stats: OfficeStats }
  | { readonly ok: false; readonly error: OfficeErrorCode; readonly message: string };

interface OfficeArtifact {
  readonly workspaceId: string;
  readonly pathHash: string; // §4 の 16 hex
  readonly version: string; // "sha256:<hex>"
  readonly file: string; // "<operation>-<paramsHash>.<pdf|png>"（拡張子は operation から導く）
  readonly sha256: string; // バイト列の "sha256:<hex>"。write の rename 前に照合する（§5）
  readonly bytes: number;
  readonly pages?: number; // PNG には無い
  readonly missingFonts: readonly string[]; // 空 = 全部見つかった
  readonly engine: { readonly id: string; readonly version: string };
}

interface OfficeStats {
  readonly ms: number;
  readonly peakRssMb: number;
  readonly cached: boolean;
}
```

**schema は型に整合する**（`v.GenericSchema<unknown, T>`）。型の正本は `types.ts` ではなく
`packages/core/src/office.ts` で、`@hns/core/office` として公開する。未知の `operation` や
`error.code` は schema が拒否する（既定値に落とさない）。golden fixture は
`packages/core/test/fixtures/office/` に**手で書いた JSON** として置く（型から起こすと契約と実装の
ずれを検出できない）。

## 3. 状態

プレビューは 7 状態。`stale` は「machine に聞けないので結果が分からない」を表し、**failed に丸めない**。

```
unsupported ─┐  ← request 時に「形式が pack の能力外」で作る
disabled    ─┼─▶ （終端。再要求は request で新しいジョブ）
              ← request 時に「engine が無い」で作る
queued ─▶ generating ─▶ ready
                      ├─▶ failed（code は OFFICE_ERROR_CODES）
                      └─▶ stale（machine 断・応答不明）
```

- `unsupported` / `disabled` の**生産者は request**（alarm ではない）。形式が manifest の能力外なら `unsupported`、
  エンジンが無ければ `disabled` の行を作り、alarm を arm しない。
  生成中にエンジンが消えた場合は `failed`（`engine_unavailable`）で、これは**実行時の失敗**であって状態の `disabled` とは別物。
- `stale` の決着は **alarm（DO の alarm + TTL）**だけが行う。alarm が machine のキャッシュを照会し、
  あれば `ready`、無ければ `failed`（engine_unavailable）に倒す。resolver は状態を返すだけで倒さない。
- 同じ `(workspaceId, path, version)` の `ready` は再生成しない。

## 4. 保存とキー（D103）

派生（プレビュー PDF・PNG）は machine のキャッシュ。ユーザーの成果物（変換 PDF）は **machine が ROOT に書く**
（§8 INV-O6。Worker の body 上限を通さない）。

```
<cache>/<workspaceId>/<pathHash>/<version>/<operation>-<paramsHash>/<pdf|png>
```

**キーは 5 つ組**（`OfficeCacheKey`）：`(workspaceId, pathHash, version, operation, paramsHash)`。どれも省略できない。

- `version` は workspace の版で、実体は内容ハッシュ（`sha256:<hex>`）。
  **同じ pathHash なら、同一内容は同じキー**になる（版は内容である。以前の「内容ハッシュをキーにしない」は
  誤り。レビュー B3）。**パスが違えば内容が同じでも別のキー**である（同じ内容の 2 つのコピーは、
  2 つの成果物として別に持つ）。
- `pathHash` = SHA-256(workspace 相対パス) 先頭 16 hex。
- `paramsHash` = **core の `officeParamsHash(operation, options)`** が返す 16 hex（JCS + SHA-256）。
  server も machine もこの 1 関数だけを使う（既定値の変更で静かに cache miss しないため。レビュー Q7）。
- **パス系はハッシュの外、キーの中**。`paramsHash` は operation と、**成果物を変える option**
  （pages・width・commands・to）だけをハッシュする。`workspaceId` / `pathHash` / `version`
  は `officeParamsHash` の入力に**入れない**（同じ内容でもパスが違えば別の成果物なので、キーの
  フィールドで分ける）。同じ成果物を 1 つのキーに写す 1 関数は `officeCachePath(key)` だけ。
- **なぜ 5 つ組か（レビュー B1）**: `convert` の option は `{ to: "pdf" }` だけである。キーを
  `operation` と `paramsHash` だけにすると、convert の key は**全 workspace・全ファイルで同じ値**に
  なり、最初の変換の PDF が 2 つ目の変換の答えとして返る。`inspect` / `edit` / `recalc`
  は成果物を作らないのでキーを持たない（`OfficeCacheKeySchema` の `operation` は
  `preview` / `render` だけ）。
- ファイル名は拡張子（`pdf` / `png`）だけ。ディレクトリの `operation-paramsHash` と合わせて
  1 つのキーを表し、名前がキーの第 2 の綴りにならない。

```ts
export interface OfficeCacheKey {
  readonly workspaceId: string;
  readonly pathHash: string; // SHA-256(パス) 先頭 16 hex
  readonly version: string; // "sha256:<hex>"
  readonly operation: OfficeOperation; // preview | render（成果物を作る 2 つだけ）
  readonly paramsHash: string; // officeParamsHash(operation, options)
}
```

- TTL 7 日 / 合計 2 GB / LRU。起動時に前プロセスの期限切れを掃除する。削除失敗は記録し次の掃除で再試行。

## 5. machine の面

**上限の適用範囲**: `Limits.maxResponseBytes`（256 KiB）は **JSON 応答**の上限。`GET /artifact` は別 route で、
`length ≤ 8 MiB` を上限とする（`Limits.maxArtifactBytes` として別項目にする）。

既存の `POST /rpc` の op 集合に 2 つ足す（`office` と `officeEngine`。`packages/core/src/machine.ts` の request/result 型にも足す）。
**既存 op の受理と応答は変えない**（op の追加は後方互換）。バイナリは `GET /artifact` という HTTP route が運ぶので、
**JSON の型（封筒）は 1 つも増やさない**。

```ts
{
  op: "office";
  job: OfficeJob;
} // → OfficeResult（convert も cache に作るところまで）
```

エンジンの能力照会は独立した op（pack の manifest を読む面が他に無い。レビュー P2）:

```ts
{
  op: "officeEngine";
} // → { available: true, id, version, formats, operations } | { available: false, reason }
```

キャッシュの読み出しは JSON の op ではなく、`GET /artifact`（バイナリ）で行う。

- `convert` は cache に PDF を作り、`artifact`（ファイル名と bytes）を返す（ROOT には書かない）。
  成果物として残すのは**別の 1 手**: 既存の `write` op の変種（`content` の代わりに構造化 `source`）で
  ROOT に資産化する。journal・版・`file.write` 監査は既存の write 経路がそのまま記録する。
  結果は `applied` / `conflict` / `unknown`（`operationId` で冪等、応答断は `unknown`、照合は stat）。
  - `source` は **構造化**する: `{ kind: "office-cache", ...OfficeCacheKey }` =
    `{ kind, workspaceId, pathHash, version, operation, paramsHash }`（文字列 key は持たない。
    名前は machine が cache の内側で `officeCachePath` から導く）。サーバーは `office` の結果の
    `artifact.key` をそのまま載せる。
    `source` と `content` は**排他**で、どちらか一方だけを載せる（両方・どちらも無しは schema が拒否する）。
    解決は `GET /artifact` と同じ 1 関数で cache 内に封じ込める（レビュー P3）。
  - `contentHash` は必須。machine は cache のバイト列の sha256 を照合してから rename する。
  - `office` の結果の `artifact` に `sha256` を含める。
  - Worker の 16 MiB / 1 MiB の body 上限を通らない。
- **プレビューの配信はバイナリ専用の HTTP route**（JSON 封筒を通さない）。JSON の応答は 256 KiB 上限なので、
  8 MiB の range を JSON で返すことはできない（レビュー O1）。

  ```
  GET /artifact?workspaceId=…&path=…&version=…&operation=…&paramsHash=…&offset=…&length=…
  → 200 application/octet-stream（Content-Range / Content-Length）+ 署名ヘッダ
  ```

  - **route と正規形**: `MACHINE_ARTIFACT_PATH`（core、`"/artifact"`）と、query を固定順
    （`workspaceId`・`path`・`version`・`operation`・`paramsHash`、続いて
    `offset`・`length`）に並べて百分率エンコードする `artifactQuery(params)` / `artifactTarget(params)`
    を core に置き、server と machine が同じ関数を使う。machine は受け取った `request.url` を
    `parseArtifactQuery` で戻して `artifactTarget` と**バイト一致**で照合する（順序違い・キー追加・
    値の差し替えは 401）。
  - **署名の対象は request target 全体**（path + query）。**`paramsHash` の canonical 形は
    `officeCanonicalize(value)`**（core）。office は JCS を 2 つ持たず、`./capability/canonical.ts`
    の `canonicalize` に委ねる（2 つの canonical 形は 2 つのキーになるため）。RFC 8785、キーは UTF-16
    コード単位順、安全な整数だけ。表現できない値はハッシュせず拒否する。
  - 既存の署名ヘッダと同じ鍵・時刻窓・nonce。
  - **cache のキーだけで解決**し、ROOT を読まない。`length` は最大 8 MiB、超えたら `invalid_request`。
  - server はバッファせず `ReadableStream` に流す。

- `artifact` は構造化する:
  `{ key, workspaceId, pathHash, version, file, sha256, bytes, pages, missingFonts, engine }`。
  `key` は §4 の 5 つ組そのもの（`OfficeCacheKey`）。`workspaceId` / `pathHash` /
  `version` は `key` の写しで、`file` は拡張子（`pdf` / `png`）だけ。
  パスは `officeCachePath(key)` だけが組み立てる（server・machine・write が同じ 1 関数）。
  クエリの `path` は人と workspace API が名乗る値で、machine が署名対象から
  `officePathHash(path)` を計算する（`pathHash` を信頼せず、署名したバイト列から導く）。
- `op: "office"` の JSON 応答に文書の中身を載せない（上記のメタだけ）。
  **JSON 応答の上限は 256 KiB**（`GET /artifact` は別 route なのでこの上限の外）。
- **実行予算**: machine は 1 リクエストに `Limits.timeoutMs`（既定 30 秒）の deadline を張る。
  office は **op 単位の deadline**（`Limits.office.timeoutMs`、既定 90 秒）を持ち、他の op の 30 秒を変えない。
  job の `timeoutMs` は `min(job.timeoutMs, office.timeoutMs - 5s)` に clamp する。
  office が有効で `office.timeoutMs < 60_000` のときは起動時に落とす（設定漏れを黙って通さない）。
- **同時実行**: machine は 1 本。埋まっていれば**待たせず** `engine_busy` を返す（既存の busy と同じ。キューを持たない）。
- **sandbox**: ROOT は rw、pack は ro、cache は rw で bind する（0194 の bind 設計に追加）。
  office の実行は `--unshare-net` で分離する（外部リンク・OLE を踏ませない）。

## 6. GraphQL（アプリ契約）

既存の失敗表現（閉じた enum + union）に合わせる。**文字列の error field を足さない。**

```graphql
union DocumentPreviewResult = DocumentPreview | OfficeFailure # not_authorized はここ
```

```graphql
enum OfficeErrorCode {
  UNSUPPORTED_FORMAT
  UNSUPPORTED_COMMAND
  INPUT_TOO_LARGE
  TOO_MANY_CELLS
  TOO_MANY_PIXELS
  ENGINE_UNAVAILABLE
  ENGINE_TIMEOUT
  ENGINE_FAILED
  ENGINE_BUSY
  OUTPUT_TOO_LARGE
  SOURCE_CHANGED
  NOT_AUTHORIZED
  CANCELLED
}
enum PreviewStatus {
  UNSUPPORTED
  DISABLED
  QUEUED
  GENERATING
  READY
  FAILED
  STALE
}
type DocumentPreview {
  path: String!
  version: String!
  status: PreviewStatus!
  url: String
  pages: Int
  bytes: Int
  missingFonts: [String!]!
  engine: String
  generatedAt: DateTime
  error: OfficeFailure
}
type OfficeFailure {
  code: OfficeErrorCode!
  message: String!
}
type OfficeEngineAvailable {
  id: String!
  version: String!
}
type OfficeEngineUnavailable {
  reason: String!
}
union OfficeEngine = OfficeEngineAvailable | OfficeEngineUnavailable
type Query {
  documentPreview(path: String!): DocumentPreviewResult!
  officeEngine: OfficeEngine!
}
type Mutation {
  requestDocumentPreview(path: String!): DocumentPreviewResult!
}
```

- `documentPreview` は状態を返すだけ。生成は `requestDocumentPreview` mutation（冪等）。
  どちらも失敗は `OfficeFailure`（not_authorized を含む）として union で返す。
- **進捗はポーリング**（生成中は 1 秒間隔）。既存の live（`/ws`）は会話 transcript 専用で、
  文書パネルは会話を持たないため使わない。専用イベントは将来の拡張。
- `url` は **Session 認可のストリーム**（`GET /api/office/preview?workspaceId=…&path=…&v=…`。
  パスは query で渡し、`/` のエンコード規則を持ち込まない）。署名 URL を作らない。
  この route は `edge/handler.ts` に足し、machine の `GET /artifact` からストリームする（body をメモリに載せない）。
- `officeEngine` は union（pack 未導入で version が無いことを型で表す）。

## 7. 監査

`office.job` を 1 本。`{ jobId, operation, path, version, inputHash, engineVersion, ms, outcome }`。
**本文・セル値・テキストは入れない。** `EVENT_NAMES`（閉集合）に追加する（core の変更）。

## 8. 不変条件

- **INV-O1** 原本は変更しない。編集は新しい版として書く（`expectedVersion` に従う）。
- **INV-O2** 入口で版を照合する。違えば `source_changed` で何もしない。
- **INV-O3** 派生はユーザーのワークスペースに書かない（キャッシュのみ）。
- **INV-O4** 失敗時に半端な成果物を残さない（temp → rename）。
- **INV-O5** 上限を超えたら**拒否**する。切り詰めて成功にしない。
- **INV-O6** 大きい成果物は machine が ROOT に書く。版照合と rename は machine の内側で行い、Worker はバイト列を持たない。

## 9. エラーと UI 文言

| code                | 意味                     | UI                                                     |
| ------------------- | ------------------------ | ------------------------------------------------------ |
| unsupported_format  | 形式が対象外（odt 等）   | 「この形式はプレビューできません」                     |
| unsupported_command | 編集・再計算の語彙に無い | 「この操作には対応していません」                       |
| input_too_large     | 入力が上限超え           | 「ファイルが大きすぎます（上限 50 MB）」               |
| too_many_cells      | セル数が上限超え         | 「ブックが大きすぎます（推定 X GB / 上限 2 GB）」      |
| too_many_pixels     | 画像が上限超え           | 「画像が大きすぎます」                                 |
| engine_unavailable  | pack が無い/壊れている   | 「Office プレビューは未設定です」＋導線                |
| engine_timeout      | 時間切れ                 | 「時間内に変換できませんでした」＋再試行               |
| engine_failed       | エンジンが失敗           | 「変換に失敗しました」＋原本は無傷                     |
| engine_busy         | 他の変換が実行中         | 「他の変換が終わるのを待っています」＋少し待って再試行 |
| output_too_large    | 出力が上限超え           | 「出力が大きすぎます」                                 |
| source_changed      | 版が変わった             | 「ファイルが更新されました」＋再読み込み               |
| not_authorized      | 権限が無い               | 既存の拒否表示                                         |
| cancelled           | 利用者が中止             | 静かに戻す                                             |

**machine の拒否コード → OfficeErrorCode の写像**: `busy` → `engine_busy`、`too_large` → `input_too_large`、
`deadline_exceeded` → `engine_timeout`、`path_denied`/`forbidden` → `not_authorized`、`invalid_request` → `unsupported_command`（形式不正）、
その他 → `engine_failed`。**入力の形式不正（`..` 入りキー等）は `invalid_request`** として扱い、封じ込めの実拒否（`path_denied`）と混ぜない。

**サイズ・形式の分類**: 形式が対象外なら `UNSUPPORTED`、大きさ・セル・画素の超過は `FAILED`（code 付き）。
両者を UI で混ぜない（レビュー B7）。`previewStatusOfError(code)`（core）が `unsupported_format` だけを
`unsupported` に、他のすべてを `failed` にする。写像の表は core の
`MACHINE_REFUSAL_TO_OFFICE_ERROR` が 1 か所で持ち、`MACHINE_REFUSALS` の全コードが載っていることを
テストで固定する（新しい拒否コードが黙って `engine_failed` に落ちない）。

**写像の唯一の例外（N3）**: `source` write は 0241 が cache を読むまで `invalid_request` で
拒否される（`OFFICE_CACHE_UNAVAILABLE_REASON`）。この理由のときだけ
`officeErrorOfRefusal(refusal, reason)` は `unsupported_command` ではなく
`engine_unavailable` を返す（契約は「未実装」の code を持たないため、「まだできない」に一番近い）。
0241 が入ったら、この定数と例外は一緒に消える。

## 10. 上限（既定）

| 項目           | 値                                         | 根拠                                   |
| -------------- | ------------------------------------------ | -------------------------------------- |
| 入力           | 50 MiB                                     | スパイク最重量 13.7 MB の 3.6 倍       |
| セル数         | 300,000                                    | RSS ≈ 60 MB + 5 KB × セル（約 1.5 GB） |
| 画素           | 24,000,000                                 | RSS ≈ 4 × 画素（約 96 MB）             |
| job timeout    | 60 s（machine 設定 90 s 前提、clamp あり） | 最重量 PDF 化 17 s の 3.5 倍           |
| 出力           | 100 MiB（machine が ROOT に書く経路）      | 31 MB PDF の 3 倍                      |
| プレビュー PDF | 50 MiB / 300 ページ                        | ブラウザに渡す上限                     |
| PNG            | 10 ページ / 幅 1600 px                     | 目視 QA の用途                         |

```ts
export const DEFAULT_OFFICE_LIMITS = {
  maxInputBytes: 50 * 1024 * 1024, // 52_428_800
  maxCells: 300_000,
  maxPixels: 24_000_000,
  timeoutMs: 60_000,
  maxOutputBytes: 100 * 1024 * 1024, // 104_857_600
} as const satisfies OfficeLimits;
```

上限は `OfficeLimits` として job に載る。ポリシーで変えられるが、**既定は core の 1 か所だけ**
（`DEFAULT_OFFICE_LIMITS`）。server も machine も既定を再計算しない。どの値も **0 や負値は拒否**
（`OfficeLimitsSchema` が正の整数だけを受ける。0 は「無制限」ではなく設定の誤り）。
machine 側の office 予算は `MIN_OFFICE_TIMEOUT_MS`（60 秒）未満なら起動時に落とし、job は
`OFFICE_DEADLINE_MARGIN_MS`（5 秒）を引いた値に clamp する。

## 11. pack の能力（manifest）

manifest の型は core の `EngineManifest`（`EngineManifestSchema`）。`capabilities.operations` は
**実際に出せる op だけ**を並べる。v0.8.7 の release バイナリは
`preview` / `render` / `convert` のみ。`inspect` / `edit` / `recalc` は sidecar（0242）が入ってから宣言する。

```json
{
  "id": "ibisoffice",
  "version": "0.8.7",
  "capabilities": {
    "formats": ["docx", "xlsx", "pptx"],
    "operations": ["preview", "render", "convert"]
  },
  "license": { "spdx": "AGPL-3.0-only", "notice": "NOTICE", "source": "SOURCE.md" },
  "files": { "bin/ibisOffice": "<sha256>" }
}
```

## 12. golden fixture と契約の検査

`packages/core/test/fixtures/office/` に**手で書いた JSON** を 25 個置く（型から起こすと、契約と
実装のずれを検出できない）。内訳:

| 群             | ファイル数 | 中身                                                                                        |
| -------------- | ---------- | ------------------------------------------------------------------------------------------- |
| job            | 3          | preview / render / convert                                                                  |
| result         | 4          | 同 3 つ + `officeEngine` の報告                                                             |
| error          | 3          | `unsupported_format` / `engine_timeout` / `source_changed`                                  |
| 拒否           | 6          | 未知 operation・preview+commands・version 不正・limits 0・未知 error.code・workspaceId 無し |
| command / cell | 4          | `OfficeCommand` 3 語彙 + `CellEdit`                                                         |
| write          | 3          | `source` / `content` / 両方（拒否）                                                         |
| key            | 2          | 同じ job・同じ version で `pathHash` 違い／`paramsHash` 違い                                |

**実ディレクトリの数: 25**（job 3 + result 4 + error 3 + 拒否 6 + command/cell 4 + write 3 + key 2）。
受け入れ条件の「fixture 12 件」は **この数え方とは別物**で、次のように分かれる:

- **成功例: 16**（job 3・result 3（`result-office-engine` を含む）・error 3・command/cell 4・write 2）。
  受入の「成功 6」は、このうち job と result の 6 本を指していた。error の 3 本は
  `ok: false` の `OfficeResult` で、成功ではないが schema は通す（失敗は成功の反対側の正常値）。
- **拒否例: 7**。`reject-*` の 6 本（未知 operation・preview+commands・version 不正・limits 0・
  未知 error.code・workspaceId 無し）と、`write` 群の「content と source の両載せ」1 本。
  受入の「拒否 6」は `reject-*` の 6 本を指していた（両載せは write の変種として足した分）。

上とは別に、key の 2 本（`key-convert-other-path` / `key-convert-other-params`）は
`OfficeCacheKeySchema` と `officeCachePath` に当てる（成功でも拒否でもなく、キーの差分の検査）。
16 + 7 + 2 = 25 で、ディレクトリの数と一致する。

型と schema の一致は `v.GenericSchema<unknown, T>`（コンパイルで固定）と `expectTypeOf` で、
閉じた union の `switch` は `assertNever` で網羅を固定する。

## 13. バージョンと互換

`v: 1`。追加は optional field のみ。破壊は v2 とし、旧 v の受理を 1 リリース残す。結果に `engine.version` を含める。
