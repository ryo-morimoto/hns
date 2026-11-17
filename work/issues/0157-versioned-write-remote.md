# 0157: 版付き書き込みのリモート化（ack が DO を通る）

status: in-progress
priority: now
design: agreed
design-ref: docs/durability.md §3.1・§3.4
depends-on: 0033, 0147, 0156
touches: packages/core/src/machine.ts, packages/core/src/machine.test.ts, packages/core/src/index.ts, packages/workspace/src/files.ts, packages/workspace/src/files.test.ts, packages/workspace/src/index.ts, packages/machine/src/wire.ts, packages/machine/src/operations.ts, packages/machine/src/signature.ts, packages/machine/src/agent.ts, packages/machine/src/wire.test.ts, packages/machine/test/integration/agent.test.ts, packages/machine/test/integration/remote-write.test.ts, packages/store/src/journal/schema.ts, packages/store/src/journal/model.ts, packages/store/src/journal/parse.ts, packages/server/src/do/machine.ts, packages/server/src/do/workspace.ts, packages/server/src/do/workspace.test.ts, packages/server/src/do/journal.ts, packages/server/src/do/journal.test.ts, packages/server/src/edge/handler.ts, packages/server/src/edge/handler.test.ts, packages/server/src/edge/worker.ts, packages/server/src/edge/env.ts, packages/server/src/files/content.ts, packages/server/src/files/content.test.ts, packages/server/test/support/machine.ts, packages/server/test/integration/workspace-do.test.ts, tools/deploy/cloudflare.config.ts, tools/deploy/config.test.ts, work/issues/0157-versioned-write-remote.md

## Goal

読み書きの経路を UI → DO → マシンにし、ack の時点で Journal と内容が確定している形にする。
TOCTOU の閉じ方（dirfd・同一ディレクトリ temp + rename）はマシン側で維持する。

**読みはマシンから返す**（R2 は読みの経路に入れない。U が見えないため）。オフラインは失敗させる。

## Acceptance criteria

- [x] 「POST /workspaces/:id/files」が DO で intent を書き、マシンで適用し、outcome を書いてから 200 を返す（面は D059 / D094 に合わせて POST /api/workspaces/:workspaceId/files に確定）
- [x] expectedVersion はマシンで再計算して比較（DO の値を信じない）
- [x] 応答が返らないときは unknown。再送で照合（INV-04）
- [x] concurrent な保存で片方が conflict になるテスト
- [x] 保存の p95 を記録（目標を決める）
- [x] 読みはマシンから。切断中は「読めない」を返し、古い内容を返さない
- [x] 外部変更（agent の shell）を検知したら、版の不一致として扱う（UI 表示は 0106。ここは REST の externalChange / conflict まで）

## Notes

- ack が DO を通るので、ローカル fsync に依存せずに RPO 0 を満たせる。
- ただし git / bash 由来の変更はここを通らない（checkpoint 0154）。
- 0156 の apply は intent / outcome を持たず、再送は conflict を返した。ここで intent / outcome に拡張し、再送は記録済みの outcome を返す（INV-04）。
- 面（REST / GraphQL）は 0182 の棚卸しで決まる。AC の POST /workspaces/:id/files は暫定のパスで、実装時に確定する（D059）。

## 追記（0127 の sandbox 調査、2026-11-17）

- machine の op は health / stat / read / list のみ。**write は 0157 が足す**。
- パスは projectRoot と path を**別々に**受け、machine が ROOT を dirfd で開いて openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS) か component walk で解決する。O_NOFOLLOW は最終要素にしか効かない。
- expectedVersion の再計算は、この解決の後に行う。
- テスト: 中間 symlink / .. / 兄弟 project を拒否する。
- 出典: [agent-sandbox-designs.md](../research/agent-sandbox-designs.md) の R3 / F3。

## Design

2026-11-17 / lead の設計 checkpoint 承認済み（Q1 touches、Q2=A の denied、Q3 p95 目標、Q4 status/priority）。

### 経路

```text
browser → edge（session 認証・method・動的 route）
        → Workspace DO /rpc/apply（lease/epoch・project 束縛・journal intent）
        → machine /rpc（control-plane 署名。dirfd で解決・再ハッシュ・同一親に temp → rename）
        → Workspace DO（outcome を記録。版表と event も更新）
        → 200 / 409 / 504（応答なし = unknown）
```

読みは同じ経路の /rpc/read。machine の bytes と版を返し、版表を更新する。

### 面（D059: schema・認証・handler を同じ変更で足す）

| 面 | path | 認証 | 作用 |
| --- | --- | --- | --- |
| read | GET /api/workspaces/:workspaceId/files?projectRoot=&path= | session | machine から bytes + version。切断中・未設定は 503（古い内容を返さない） |
| write | POST /api/workspaces/:workspaceId/files | session | 版付き保存。200 / 400 / 404 / 409 / 415 / 503 / 504 |

- 0182 の棚卸しの server/src/files/content.ts。AC の POST /workspaces/:id/files は暫定で、/api/ 配下に置く（D094 の「/api/* の未知は 404」と揃える）。
- write の body は { projectRoot, path, expectedVersion, operationId, content }（content は UTF-8 テキスト。base64 は DO ↔ machine の内部 RPC だけ）。
- 応答は閉じた union。applied は 200 { ok: true, status: "applied", operationId, path, version }、conflict は 409 { ok: false, code: "conflict", operationId, path, currentVersion }、unknown は 504 { ok: false, code: "unknown", operationId, path, reason }（成功扱いにしない。D092）、lease は 409 { ok: false, code: "lease", reason }（版 conflict と区別）、denied は 400、unavailable は 503、入力不正は 400、バイナリ読みは 415。problem+json と混ぜず、この面の code はこの union の語彙。
- edge は session 認証・method・動的 route だけを持ち、HandlerDependencies.files（0162 の obs と同じ形）へ委譲する。Worker は Workspace DO へ /rpc/apply / /rpc/read を転送する。
- operationId はブラウザが 1 保存に 1 つ作り、再送は同じ id で同じ結果を返す。

### 契約の置き場

- **machine との内部 RPC の型と schema は @hns/core/src/machine.ts**。署名メッセージ（hns.machine.request.v1 の JSON 配列）・署名ヘッダ名・RPC path・write op の request / result・read result を 1 箇所に置き、Worker 側の署名と machine 側の検証が同じ定義を使う（2 つ以上のパッケージが使う型は core。docs/packages.md）。machine の signature.ts / wire.ts はここから import して重複定義を消した。x-request-id は署名対象外（TSDoc と test で固定）。
- **dirfd 解決と temp + rename は @hns/workspace/src/files.ts**（Node 実装。machine だけが使う）。rooted-helper の procFd / openAt / openParentChain / openTarget / hashFile / expectRegular / namesOf をここへ抽出し（挙動を変えない単独 commit）、rooted-helper と machine の両方が使う。root の同一性は machine が起動時に取った dev / ino を毎回照合する。
- **REST 面の schema と handler は @hns/server/src/files/content.ts**（D059。core に封筒を戻さない）。
- **DO の機械呼び出しは @hns/server/src/do/machine.ts**。MachineFiles port（write / read）と、HNS_AGENT_URL + control-plane 鍵で署名する実装を分ける。port を fake にできるので、unit は鍵もネットワークも要らない。
- **machine の id は per call**（MachineCall.machineId）。write は lease の保持者、read は lease 取得時に workspace_meta へ残した machine を使う。machine registry は 0148。

### machine の write op

```ts
{ op: "write", projectRoot: string, path: string, expectedVersion: string,
  operationId: string, content: string /* base64 */, contentHash: string /* sha256:<hex> */ }
```

1. projectRoot と path を**別々に**検証する（NUL・絶対・ドライブ・.. を拒否）。ROOT を dirfd で開き、projectRoot の各段 → path の親の各段を O_NOFOLLOW | O_DIRECTORY で辿る。兄弟 project は projectRoot の外なので届かない。
2. 最終要素を O_NOFOLLOW | O_NONBLOCK で開き、sha256:<hex> を計算する（**machine で再計算した expectedVersion**。DO の値を信じない）。
3. 現在の版 == contentHash → applied（適用済みで outcome を欠いた再送の照合。durability §3.1 の死んだ窓2）。
4. 現在の版 != expectedVersion → conflict + currentVersion。1 バイトも書かない。
5. contentHash が届いた bytes の hash と違う → 何も書かず invalid_request（intent の内容を守る）。
6. 一致 → 同一親ディレクトリに .hns-tmp-<uuid> を書き、fsync してから dirfd 相対で rename。結果は applied + version。temp は成功・失敗のどちらでも残さない。rename 後に再 hash し、変わっていれば unknown。
7. 明確な拒否（path_denied / forbidden / not_found / invalid_request / too_large）と、不明（deadline_exceeded / busy / internal）を分ける。前者は「書いていない」、後者は「書いたか分からない」。
8. 同じ root・path の write は machine 内で直列化する（withWriteLock）。同時 2 本が同じ expectedVersion を通るのを防ぎ、片方を conflict にする。

read / list / stat の形は変えない（後方互換）。**非対称の理由**: write は project 境界を越えないことを machine で証明する必要がある（AC と 0127 追記）が、read の攻撃面は DO の認可（session + project 束縛 + 同じ検証関数）と machine の ROOT containment で閉じる。DO は read でも projectRoot と path をそれぞれ検証してから projectRoot + "/" + path を渡し、不正なら machine を呼ばない（テストで固定）。machine の ROOT containment は第 2 の防衛線として残る。

### Workspace DO

- POST /rpc/apply を拡張した（0156 の「caller が version を渡す」面を置き換え）。
  1. 入力検証（path / projectRoot / base64）。
  2. lease / epoch / workspace / project 束縛を 1 トランザクションで検証（拒否は intent を書かない）。machineId / epoch は machine のツール呼び出しでは必須、Worker（エディタ）経路では省略でき、省略時は lease の保持者を使う。
  3. journal.appendIntent（本文 ≤ 256KB は行、超は R2 → 行。再送は recorded outcome / pending / denied）。settled の operation id に別の内容が来たら denied（INV-04）。
  4. machine へ write を送る（x-request-id は署名対象外で載せる）。
  5. machine の applied / conflict / unknown を outcome に記録してから応答する（INV-10）。applied は版表と event（created / changed）も更新する。
  6. 応答なし → unknown（reason timeout）。明確な拒否 → denied（reason は machine の refusal code）を outcome に記録する。**denied も outcome として intent を settle する**ので、checkpoint の watermark が進める（0169 の「未確定 intent は越えない」を守る）。
- GET /rpc/read は machine の read を呼び、版表を更新する。版表と machine の版が違えば externalChange: true（AC7 の検知。表示は 0106）。machine が無い / 未設定なら 503 で内容を返さない。
- projectRoot は最初の成功した write / read で workspace_meta に束縛する（workspace_id と同じ fail closed）。違う値は 400。
- 旧 /rpc/apply の「version を caller が渡す」経路は消した。書き込みが DO を通る 1 本だけになる（durability §11）。

### Journal と denied

- @hns/store の JOURNAL_OUTCOME_STATUSES に denied を足した。MutationResult（アプリ契約）は変えない。denied の reason は machine の refusal code（閉じた語彙は machine 側）。
- SQLite は CHECK を広げられないので、**古い DDL の journal 表は開くときに 1 トランザクションで作り直す**（rename → create → copy → drop → index 再作成）。行は失わない。unit で旧 DDL からの再構築を固定。

### 署名と 0148

- Worker → machine は control-plane の Ed25519 秘密鍵（HNS_CONTROL_PLANE_KEY、Worker の secret）で署名し、machine は enrollment で配られた公開鍵で検証する（D100）。Workers の WebCrypto Ed25519 で実際に動くことを cf dev の実経路で確認した。
- 0148 の registry はまだ無い。MachineFiles port / 署名関数を seam にし、unit は固定鍵と fake で回す。machine の選択（どの machine に書くか）は lease / workspace_meta で、鍵の配布・rotation・registry が 0148 待ちである。
- x-request-id は署名対象にしない（0162 の契約）。本文・content・token はログに残さない（machine の write 失敗は failure と refusal code / error 名だけを残す）。

### 計測（AC5）

- 目標: **保存 e2e p95 ≤ 1s**（D092 の保存 p95）、**DO 側（intent + machine hop + outcome、machine 内の rename を含む）p95 ≤ 150ms**（durability §8 の撤退条件の内側に置く）。
- 実測（2026-11-17、cf dev + 実 machine agent + 実 fs、127.0.0.1、n=20、warmup なしの連続保存。2 回）: **p50 19.1–20.0ms / p95 29.2–34.5ms**。cloudflared / tunnel 越しは 0148 の registry と実機が要るので取っていない（0167 の故障注入で扱う）。
- 観測は 0162 の x-request-id と ObsLogEntry（hop worker / do / fs）をそのまま使う。保存 1 回の相関 ID で edge → DO → machine を辿れることをテストで固定した。

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | lease 保持 → write → intent → machine が applied → outcome + 版 + event が入り、200 | 高 | 受入1、INV-10 |
| C2 | 版表は一致だが machine の再計算は不一致（外部変更）→ conflict。applied にせず、版表も進めない | 高 | 受入2、AC7、INV-03 |
| C3 | machine の応答が返らない → outcome unknown(timeout)・504。同じ operationId の再送は同じ unknown で、intent も machine 呼び出しも増えない | 高 | 受入3、INV-04 |
| C4 | intent だけがあり outcome が無い（適用後・outcome 前に落ちた）→ 同じ operationId で再送 → machine が current == contentHash で applied | 高 | 受入3、§3.1 窓2 |
| C5 | 同じ operationId で別の内容 → denied。intent は増えず machine も呼ばない | 高 | INV-04 |
| C6 | 同じ expectedVersion の 2 つの write が同時 → 片方 applied・片方 conflict。machine の適用は 1 回 | 高 | 受入4、INV-03 |
| C7 | lease 未取得 / 期限切れ / 古い epoch → 0156 の refusal。intent を書かず machine を呼ばない | 高 | 受入1、§3.4 |
| C8 | 別 workspace / 束縛後と違う projectRoot → 400。machine を呼ばない | 高 | 受入1、認可 |
| C9 | 不正な path / expectedVersion / operationId / body → 400。intent を書かず machine を呼ばない | 中 | 受入1、D059 |
| C10 | machine の明確な拒否 → denied の outcome で intent が settle し、再送は同じ denied。watermark がその intent を越えられる | 高 | 受入1、0169 |
| C11 | 本文が 256KB ちょうど / +1 → 行 / R2 に 1 回 put（journal の境界） | 高 | 受入1、§3.1 |
| C12 | read → machine の bytes と版。版表が古ければ externalChange: true で更新 | 高 | 受入7、AC7 |
| C13 | machine が落ちている → read は 503 で内容を返さない（古い内容を返さない） | 高 | 受入6、§4 |
| C14 | machine の write op: 内容と版（sha256）を返し、temp を残さず、最終要素が symlink / FIFO / ディレクトリなら拒否 | 高 | 受入1・2、§3.1 |
| C15 | machine の write op: 中間 symlink / .. / 絶対 / 兄弟 project / contentHash 不一致 → 拒否。内容は書かれない | 高 | 受入1・2、0127 追記 |
| C16 | machine の write op: expectedVersion 不一致 → conflict + currentVersion、1 バイトも書かない。再送（current == contentHash）→ applied | 高 | 受入2・3、INV-03 |
| C17 | REST: cookie 無し 401 / 不正 method 405（Allow 付き）/ 深い path 404。認証は body を読む前 | 高 | 受入1、0145 |
| C18 | REST: applied 200 / conflict 409 / unknown 504 / lease 409 / denied 400 / unavailable 503 の union をそのまま返し、unknown を成功に丸めない | 高 | 受入3・6、D092 |
| C19 | REST: 保存 1 回の相関 ID が edge → DO → machine の fs.op まで同じ。本文・content・token はログに出ない | 高 | 受入5、0162 |
| C20 | 実経路（cf dev + 実 machine agent + 実 fs）: acquire → write 200 → 実ファイル一致 → 再送 applied → 同時 2 本で片方 conflict → 外部書き換え後の read が externalChange → stale 409 → machine 停止で read 503・write unknown。保存 20 回の p50 / p95 を記録 | 高 | 受入1–5 |
| C21 | 全変更 → npm run check → exit 0 | 高 | Result |

テストしない条件:

- cloudflared / tunnel 越しの実測と、実機の machine 喪失（理由: 0148 の registry と実機が要る。0167 の故障注入で扱う）。
- 電源断・プロセスクラッシュの各窓（理由: 0167。ここは窓2の照合を pending intent で固定する）。
- UI の unknown / conflict / externalChange 表示（理由: web は 0157 の touches 外。0106 の EditorBuffer が持つ。ここは REST の union まで）。
- Windows / macOS（理由: dirfd 経路は Linux のみ。docs/workspace.md）。
- バイナリの編集と 8MiB 超の read（理由: 0106 / 0125 の範囲。ここは UTF-8 以外の read を 415 にするところまで）。

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 状態遷移 | unit（実 SQLite + fake machine） | server/src/do/workspace.test.ts の applied 経路 |
| T2 | C2 | 故障注入（machine の conflict） | unit | 同 "the machine's re-hash decides a conflict, not the version table" |
| T3 | C3 | 故障注入（応答なし） | unit | 同 "a missing answer is unknown and a retry keeps the recorded outcome" |
| T4 | C4 | 状態遷移（pending intent の再送） | unit | 同 "a pending intent is reconciled by the machine's content hash" |
| T5 | C5 | 同値分割（同じ / 違う operationId の内容） | unit | 同 "the same operation id with different content is denied before the machine" + do/journal.test.ts "a settled operation id with different content is denied" |
| T6 | C6 | 競合テスト | unit（fake は write を直列化） | 同 "only one of two concurrent writes at the same expected version applies" |
| T7 | C7 | 状態遷移（lease / epoch） | unit | 同（lease テスト群） |
| T8 | C8・C9 | 同値分割（束縛・不正入力） | unit | 同 "a write for another project root is refused before the machine" / "an unsafe path is refused by apply and read without calling the machine" |
| T9 | C10 | 状態遷移 + watermark | unit | do/workspace.test.ts "a definite machine refusal settles a denied outcome and a retry returns it" + do/journal.test.ts "a denied outcome settles its intent and the watermark may pass it" |
| T10 | C11 | 境界値（256KB / +1） | unit（fake bucket） | do/journal.test.ts "a body at the inline limit stays in the row and one byte more goes to the bucket" |
| T11 | C12・C13 | 状態遷移 + 故障注入 | unit | do/workspace.test.ts "a read returns the machine's bytes and flags an external change" / "a read while the machine is unreachable returns no content" |
| T12 | C14・C15・C16 | 同値分割 + 故障注入 + 境界 | unit（実 fs・temp dir） | workspace/src/files.test.ts の 7 本（置換・stale・再送・contentHash・親 symlink / .. / 兄弟 / 絶対・最終 symlink とディレクトリ・root 差し替え） |
| T13 | C14・C15・C16 | 故障注入（実 fs） | integration（machine agent・実 HTTP・署名） | machine/test/integration/agent.test.ts "a signed write applies once, conflicts on a stale version, and refuses an escape" |
| T14 | C17 | デシジョンテーブル | unit | server/src/edge/handler.test.ts "the files face requires a session and only GET or POST" |
| T15 | C18 | 契約（union の往復） | unit（実 DO + fake machine + face） | server/src/files/content.test.ts の 8 本（applied / conflict / unknown / denied / lease / 不正 body / read / 404・503） |
| T16 | C19 | 契約（相関 ID） | integration（実経路） | machine/test/integration/remote-write.test.ts の corr-read / corr-save |
| T17 | C20 | ユースケース（実経路） | integration（cf dev + 実 machine + 実 fs） | 同（1 ファイル 2 テスト: 実経路と machine 停止） |
| T18 | C21 | ゲート | static / build | npm run check |

層の判断: DO の遷移・journal・版表は実 SQLite（node:sqlite、単一プロセス）の unit で、machine の dirfd 解決と temp/rename は実 fs の unit で証明する。machine の署名付き HTTP は既存の integration（実 HTTP）に write op を足した。実 workerd + 実 machine + 実 fs の経路は 1 ファイルにまとめ（cf dev の起動コスト）、p50 / p95 を記録する（決定的な閾値のテストにはしない）。

## やらないこと

- バッチ保存（0055）。
- 外部変更の UI 表示（0106）。
- R2 の restore（0155）。
- machine registry / control-plane 鍵の配布・rotation（0148。ここは seam と固定鍵）。
- バイナリ編集・8MiB 超の read（0106 / 0125）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-17: 0156 の Result を受けて、intent / outcome への拡張をこの issue の範囲にした（touches に do/workspace.ts）。面は 0182 の棚卸しに従う。
- 2026-11-17: 0154 / 0169 / 0162 の後に lead が next から now へ。REST content の面は D089 / D092、鍵は D100（control-plane）。
- 2026-11-17: 設計 checkpoint を lead に送り、承認。Q1 touches（tools/deploy は 0157 単独、lock は触らない）、Q2=A（denied を outcome 語彙に足す）、Q3 p95 目標、Q4 status/priority。
- 2026-11-17: 実装。(1) files.ts 抽出（挙動不変の単独 commit。workspace の unit + integration 77 tests green）、(2) core の machine RPC 契約 + machine の write op（実 fs の unit 7 + machine の実 HTTP integration 1）、(3) store の denied + DO の apply / read / machine client / face / deploy、(4) 実経路 integration（cf dev + 実 machine agent + 実 fs、p50 19.1ms / p95 34.5ms）。
- 2026-11-17: 実装中の発見。(a) journal の settled 再送が内容を比べておらず、同じ operationId の別内容が古い outcome を返していた（appendIntent で intent の body hash / path / expectedVersion を比較して denied に修正）。(b) workerd は fetch の redirect: "error" を実装していない（manual に変更）。(c) SQLite の CHECK は広げられないため、旧 DDL の journal 表を開時に作り直す。
- 2026-11-17: 独立レビュー待ち（この issue は done にしない）。

## Result

- verdict: 未実施（独立レビュー待ち。この issue は done にしない）
- reviewer: —（実装を書いていない agent を lead が割り当てる）
- HEAD: a71d89f（コード。README とこの記録は別 commit）
- 受入: 7/7。証拠は「テスト設計」の各行に対応するテスト。
- ゲート: `npm run check` exit 0（688 tests / 36.0s 前後、lint 0 warnings / fmt / codegen / typecheck / test（統合と cf dev を含む）/ build / deploy dry-run / knip すべて ok）。
- 計測: 保存 20 回の p50 19.1–20.0ms / p95 29.2–34.5ms（cf dev + 実 machine + 実 fs、127.0.0.1。目標は e2e p95 ≤ 1s、DO 側 ≤ 150ms）。tunnel 越しは未計測（0148 / 0167）。
- 実経路で確認したこと: workerd の WebCrypto で Ed25519 署名が動き、machine が control-plane 公開鍵で検証する（D100 の向き）。`x-request-id` は署名対象外のまま machine の `fs.op` ログに届く。machine 停止で read 503 / write unknown。
- 非 blocking（follow-up）: tunnel 越しの p95 と実機の machine 喪失（0167）/ machine registry と鍵の配布・rotation（0148）/ UI の unknown・conflict・externalChange 表示（0106）/ machine の read は projectRoot を分離しない（DO の検証 + ROOT containment。理由は Design）/ knip の configuration hint（`.agents/**` と workspace の rooted-helper entry）は本変更の前後どちらでも出る設定メモ。/ 保存経路の `operationId` は REST の利用者（0106）が作る前提で、面は空文字を拒否するだけ。
