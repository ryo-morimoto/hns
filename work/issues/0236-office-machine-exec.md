# 0236: machine で Office ジョブを実行する

status: in-progress
priority: now
design: agreed
design-ref: D102, D103, docs/office.md
depends-on: 0234, 0235, 0194
touches: packages/machine/src/office/, packages/machine/src/wire.ts, packages/machine/src/operations.ts, packages/machine/src/agent.ts, packages/machine/src/limits.ts, packages/workspace/src/sandbox.ts

## lead の補足（0235 の Result から）

- **pack の manifest は `files`（`sha256:<hex>` の文字列のみ）と、型の外の `build.symlinks` / `build.runtime.bindPaths`** を持つ。**0236 は `EngineManifestSchema` で `files` までを検証**し、**`build.*` は「machine が読む運用情報」**として扱う。
- **`runtime.bindPaths` は ro bind に写す**（`0194` の sandbox の binds に 1 段）。**build 時に解決済みの絶対パス**なので、**探索しない**。**パスが無いときは render だけ `available:false`（reason にパス）、preview / convert は成功**。
- **同じ manifest でもホストによって `available` が変わる**点は 0235 の Result の follow-up。**0236 の preflight で `--assume-binds` のようなモードを検討**（同じ pack なら同じ答えを返したい利用者のため）。
- **`build.sh` は同じ checkout で並行に走らせると壊れる**（0235 の follow-up）。**0236 のテストが pack を同時に作らない**こと。

## Intent

UI とエージェントの要求を machine で安全に・決定的に実行する。エンジンは自分を守らない（timeout もメモリ上限も無い）。
封筒（事前スキャン・op 単位の打ち切り・キャッシュ・sandbox・配信のチャンク読み）を hns 側が持つ。

## Goal

`POST /rpc` に `op: "office"`（preview / render / convert）を足し、キャッシュの読み出しは `GET /artifact`（バイナリ・署名付き）で行い、
派生はキャッシュに、変換の成果物は machine が ROOT に書き、`OfficeResult` を返す。上限超過は実行前に拒否し、
timeout は必ず打ち切る。inspect / edit / recalc は sidecar（0242）が入るまで `unsupported_command`。

## Acceptance criteria

- [x] `op: "office"` を受理し、preview / render / convert を実行する（他は `unsupported_command`）
- [x] `op: "officeEngine"` が pack の manifest を読み、`{ available, id, version, formats, operations }` を返す（manifest 無し・不正は `available: false` + reason）
- [x] 事前スキャン（エントリ数・展開後サイズ・セル数・画素数）で上限超過を**実行せず**拒否する
- [x] **op 単位の deadline**（`Limits.office.timeoutMs`、既定 90 秒）を適用し、job は `min(job.timeoutMs, office.timeoutMs - 5_000)` に clamp。
  `office.timeoutMs < 60_000` の設定は起動時に拒否する。他の op の 30 秒は変えない
- [x] 実行中に別の job が来たら**待たせず** `engine_busy`。`officeEngine` は読み取り専用で、単一実行枠を取らない
- [x] `Limits.maxResponseBytes`（256 KiB）は JSON 応答の上限に限定し、artifact は `Limits.maxArtifactBytes`（8 MiB）で別に持つ
- [x] 同じキー（docs §4）はキャッシュを使い、実行しない。結果の `stats` に `cached: true` を返す
- [x] キャッシュは TTL 7 日 / 2 GB / LRU、起動時に前プロセスの期限切れを掃除
- [x] `GET /artifact`（バイナリ・署名付き）がキャッシュの派生だけを返す（ROOT は読まない・`length` は最大 8 MiB）
- [x] `GET /artifact` の署名は **request target 全体**（`MACHINE_ARTIFACT_PATH` + 正規化した query）を検証する。query を差し替えると 401
- [x] `convert` の結果 `artifact` に `sha256` を含める
- [x] bwrap が使えないときは `engine_unavailable`（fail closed）
- [x] office 実行の sandbox は pack を ro、cache を rw で bind し、`--unshare-net` で分離する
- [x] `convert` は **cache に PDF を作り、`artifact.key` と bytes を返す**（ROOT には書かない。資産化は 0241 の write 変種）
- [x] machine の拒否コードを docs §9 の表で `OfficeErrorCode` に写像する
- [x] `stats` に `{ ms, peakRssMb, cached }` を返す

## テスト条件

- C1: セル 40 万 → 実行せず `too_many_cells`
- C2: 5,000 万画素 → 実行せず `too_many_pixels`
- C3: timeout 1 ms → `engine_timeout`、子プロセスが残らない
- C4: 同じ job を 2 回 → 2 回目は生成が走らず `stats.cached === true`
- C5: 版が違う → `source_changed`
- C6: bwrap 無し → `engine_unavailable`
- C7: 実行中に 2 本目 → `engine_busy`
- C8: office op 単体では convert は cache だけに書き、ROOT が変わらない
- C9: 外部リンク入り docx → 変換は成功し、外向き接続は起きない（netns）
- C10: 変換が落ちる → 半端なファイルが残らない
- C11: `GET /artifact` の `version` が `sha256:` でない / `workspaceId` に `..` / `length > 8 MiB` → `invalid_request`
- C12: `office.timeoutMs = 30_000` で起動 → 起動時に拒否
- C13: 署名無しの `GET /artifact` → 401
- C14: `GET /artifact` の query を差し替え（version を別の値に）→ 401
- C15: 生成中に `officeEngine` → busy ではなく能力を返す

## テスト設計

- T1: C1/C2 → prescan 単体 + integration
- T2: C3/C7 → 故障注入・並行性 → integration
- T3: C4 → `stats.cached` と子プロセス spy → integration
- T4: C5/C6/C8/C10 → 状態と残骸 → integration
- T5: C9 → netns → integration
- T6: C11/C13 → 入力検証と署名 → unit / integration
- T7: C12 → 起動検証 → unit
- T8: C14 → 署名対象の検証 → integration

## Problem / context

スパイクで、重い xlsx は 2.5 GB / 100 万セルは 4.4 GB、病的な入力では 441 秒走って OOM abort した（S18/S20）。
machine は 1 リクエスト 30 秒の deadline を持つ。office の 60 秒をそのまま載せると必ず先に切られるので、
op 単位の deadline と clamp が要る（レビュー B2 / N10）。

## Users and use cases

- 利用者: 大きすぎるファイルで固まるのではなく、理由付きで断られる。
- エージェント: 失敗の種類（形式・大きさ・時間・混雑）で次の手を選べる。
- 運用者: 同時 1 と上限で負荷が読める。

## Non-goals

- 表示（0238）・状態管理（0237）・ツール定義（0240）。
- inspect / edit / recalc（0242）。
- エンジンの改修・LibreOffice フォールバック（D102）。

## Options and trade-offs

| Option | Summary | Pros | Cons | Risk | Cost |
| --- | --- | --- | --- | --- | --- |
| A（採用） | machine の op として実行し、cache の read op も足す | 既存の署名・sandbox・上限に乗る | wire と sandbox の変更 | 中 | 中 |
| B | server から直接プロセス起動 | 経路が短い | Worker からは不可能 | 高 | — |
| C | 外部の変換サービス | 実装が軽い | D102 に反する | 中 | 中 |
| Do nothing | 変換しない | 安全 | 体験が無い | — | — |

## Recommendation

A。配信は cache 専用の read op に分ける（ROOT の read は cache の外に届かない）。

## Design: guide-level

```ts
{ op: "office",
  job: { v: 1, id: "office-1750", operation: "convert",
         input: { workspaceId: "ws-1", path: "提案書.docx", version: "sha256:…64hex…", format: "docx" },
         limits: { … } } }
→ { ok: true, artifact: { key: "…/convert-ab12.pdf", bytes: 1_200_000, pages: 3, missingFonts: [], engine: {…} },
    stats: { ms: 1860, peakRssMb: 267, cached: false } }
```

## Design: reference-level

- パスは ROOT 相対に正規化（既存の `resolve` と同じ）。`GET /artifact` は **cache のキーから解決**し、ROOT を見ない。
- 実行環境: `HOME=<temp>`、`FONTCONFIG_FILE`、`VK_ICD_FILENAMES`、`LD_LIBRARY_PATH=<pack>/lib`。**継承しない**。
- 引数は配列。拡張子は `format` と一致。出力は temp → rename → magic 検証。
- sandbox の bind: pack ro / cache rw / ROOT rw（convert の出力先のみ）。
- 拒否コードの写像は docs §9。

## Invariants and failure modes

- INV-O4/O5。子プロセスは必ず reap。キャッシュ削除失敗は記録し再試行。
- エンジンが signal で落ちたら `engine_failed`（リトライしない）。
- convert の応答が途切れたら `unknown`（server が stat で照合）。

## Cross-cutting concerns

- security: untrusted zip/XML、netns、パス封じ込め。
- observability: `stats`（ms / peakRss / cached）と拒否コード。
- cost: 同時 1。巨大ファイルは事前拒否。
- performance: 通常 docx 1.9 秒、重い xlsx 17 秒（S12）。

## Compatibility, migration, rollback

op の追加（後方互換）。ロールバックは op の削除（キャッシュは TTL で消える）。

## Test plan

unit（prescan / キー / 正規化 / 写像 / 起動検証）、integration（実プロセスで preview / render / convert / artifact / timeout / busy / netns / bwrap 無し）。

## Rollout and graduation

pack が入った環境で smoke。`officeEngine` が available になったら web と agent を flag で有効化。

## Notes

- 実測: [ibisoffice-spike](../work/research/ibisoffice-spike/README.md)（S12/S12b/S18/S20/S21/S22）。
- machine の上限: `packages/machine/src/limits.ts`。

## 未確定

- U-01: キャッシュのルート（XDG_CACHE_HOME）/ 仮説: XDG / 影響: 権限・掃除 / 責任者: user / トリガー: 実装時。
- U-02: peakRss の測り方（子の VmHWM）/ 仮説: それで足りる / 影響: stats / 責任者: agent / トリガー: 実装時。
- U-03: `office.timeoutMs` の既定（90 秒）/ 仮説: 90 秒 / 影響: 大きい文書 / 責任者: user / トリガー: S12 の追試。

## やらないこと

- inspect / edit / recalc（0242）。
- エンジンの改造・LibreOffice フォールバック。
- 分散実行・複数同時実行・自動リトライ。

## Log

- 2026-11-17: 作成。
- 2026-11-17: レビュー 1 回目（B1〜B10）対応。
- 2026-11-17: レビュー 2 回目（N1/N8/N10）対応: cache の配信、op 単位 deadline、`operations.ts`、`stats.cached`、起動検証。
- 2026-11-17: convert を「cache に作る」に限定し、ROOT への資産化は 0241 の write 変種へ分離。
- 2026-11-17: レビュー 3 回目（O1/O10）対応: `GET /artifact` route、入力検証。
- 2026-11-17: レビュー 4 回目（P1/P2）対応: 署名対象を request target 全体に、`op: "officeEngine"` を追加。

## Result

- 設計レビュー: issue-reviewer / **PASS with comments**（2026-11-17、5 ラウンド。blocking 0）
- blocking: なし（R1〜R10 の整合修正を反映済み）
- 次アクション: 0234 → 0235 → 0236 の順で実装レーンへ（0240 / 0242 は設計レビューで agreed に）

## Result

- verdict: **PASS**（reviewer-0236。FAIL 1 回 —— **署名が指す対象と実際に配る対象がバイト一致しない**（小文字 escape の再エンコードが通る）—— を直して PASS）
- HEAD: 49d6236（main に ff 統合）。gate は **`HNS_REQUIRE_OFFICE_PACK=1` で** exit 0（**1906 tests / 1907**、main で 184.1s）。**machine の実 pack 統合 14 本は実エンジンで走る**（skip されていない）。
- **`op: "office"`**（preview / render / convert）と **`op: "officeEngine"`**（**枠を取らない**）。**事前スキャンは spawn の前**で、**入力のサイズを信じない**（中央ディレクトリを先に読み、**展開は 64 MiB の予算で打ち切る**）。
- **deadline** は **プロセスグループごと殺し**（timeout と **request の abort** の両方、`--die-with-parent`）、**他の op の 30 秒は不変**、**`office.timeoutMs < 60_000` は起動時に拒否**。
- **単一実行枠**（2 本目は `engine_busy`）、**cache は 5 つ組**で **TTL 7 日 / 2 GiB / LRU**、**起動時に掃除**、**`stats {ms, peakRssMb, cached}`**。
- **`GET /artifact`**: **署名は request target 全体**で、**`target !== artifactTarget(parseArtifactQuery(target))` をバイト一致で比較**。**小文字 escape / `%3a` / `+` / 余分な組 / 並べ替えはすべて拒否**、**canonical な range は往復**（欠けた range は欠けたまま）。**cache の派生だけを返し、ROOT を読まない**、8 MiB。
- **sandbox**: **host ro / runs の tmpfs / run rw / pack ro / `bindPaths` ro（digest 検査）/ `--unshare-net` / `--clearenv` + manifest の env（固定 PATH）/ ULIMIT_AS を exec の前**。**bwrap が無ければ `engine_unavailable`**。**run の後始末は全経路**。
- **C2（`too_many_pixels`）は engine が書いた PNG の IHDR を読み、cache する前に拒否**。**読めない寸法は `engine_failed`**（0 として数えない）、**cache を汚さない**。
- **`unsupported_format` と `unsupported_command` を §9 の表どおりに分けた**（pack が扱わない形式 / op 未宣言・pages・sidecar）。
- **`/tmp` の件は実装担当の再現ミス**（argv の貼り付けでエンジンに `&&` が渡っていた）と判明。**製品の `runEngine` を直接呼ぶと pack を `/tmp` 直下に作っても `ok`**。**テストはコピーで誤魔化していない**。
- **レビューで直したもの**: ①署名対象のバイト一致 ②**受入にありながら未実装だった `too_many_pixels`** ③`unsupported_format` の写像（テストを書く過程で表とのずれが出た）④`HNS_OFFICE_CACHE` が `HNS_OFFICE_WORK` と同時設定で落ちる ⑤**新しい `no-unused-vars` 6 件と第二の正本**（`CONTENT_TYPE_OF_OPERATION`）。
- **実運用で起動する**: machine が Office のジョブを実行し、`GET /artifact` で署名済みのバイトを配る。**server → machine の署名済み RPC 経由の実経路は未検証**（machine の HTTP route のみ）——**0237 で通す**。
- **残件（正直に）**: ①**C3 は殺した後に子プロセスが残らないことを観測していない**（コードは `-pid` に送る）②**読めない PDF はページ数で拒否されない**（`pages: 0`、エンジンが型付きのコードで落ちる）③**`peakRssMb` は 50ms サンプル**で短いスパイクを取り逃し得る ④**1 machine 1 workspace の前提**（`workspaceId` は照合されず、cache の namespace と `/artifact` の key が呼び出し側任せ）⑤**50 MiB の入力を 2 回読む** ⑥`packReport` が**ホストを見ずに `available:true`** を返す（0235 の follow-up）⑦`unsupportedReason` の pages / sidecar の分岐は単体で固定されていない ⑧`bomb()` の CRC が 23 秒のうち 15 秒。
