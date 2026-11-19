# 0154: checkpoint commit（refs/hns・Run 境界）

status: done
priority: now
design: agreed
design-ref: docs/durability.md §5
depends-on: 0153, 0156
touches: packages/workspace/src/checkpoint.ts, packages/workspace/test/integration/checkpoint.test.ts, packages/workspace/package.json, packages/workspace/tsdown.config.ts, packages/workspace/README.md, work/issues/0154-checkpoint-commit.md

## Goal

Run の終わりに、作業ツリーを commit にして `refs/hns/checkpoints/<runId>` を進める。
ユーザーのブランチは動かさず、commit を強制しない。

## Acceptance criteria

- [x] `git stash create` 相当で working tree を commit 化（untracked を含む範囲を決める）
- [x] `refs/hns/checkpoints/<runId>` を更新。ユーザーの ref は触らない
- [x] `.gitignore` 対象を含めない
- [x] Run が失敗・中断したときの checkpoint の有無を決める
- [x] 同一 Run の再実行で二重に ref を進めない（operationId で冪等）
- [x] 実リポジトリでのテスト（temp の git、モックなし）

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | tracked 変更・untracked 追加・tracked 削除のある作業ツリー → checkpoint → commit の tree が作業ツリーと一致し、HEAD・ブランチ・index は動かない | 高 | 受入1・2 |
| C2 | 同じ runId で2回 checkpoint（2回目はツリーを変えてから）→ commit と ref は1回目のまま、2回目は `created: false`。同時に2回呼んでも ref を二重に進めない | 高 | 受入5 |
| C3 | `.gitignore` 対象・`.hns/`・`.env`・資格情報ファイルがある → checkpoint → commit に含まれない。**tracked の `.env` / `.hns` も同じく含まれない**。通常の untracked は含まれる | 高 | 受入1・3、追記 |
| C4 | 別 runId で checkpoint → ref が2本になり、先の ref とユーザーの HEAD は動かない | 中 | 受入2 |
| C5 | checkpoint → 返る pack を空のリポジトリで `git index-pack` → commit から tree / blob を辿れ、commit は pack に1つだけ | 高 | 受入2、0153 との境界 |
| C6 | root が work tree のサブディレクトリ → checkpoint → commit には root 配下だけが入り、兄弟ファイルは入らない | 中 | 受入1 |
| C7 | 空の runId・`/`・`..`・`.lock` 終わり → CheckpointError（invalid-run-id）で、ref は作られない。git 管理外のディレクトリ → not-a-work-tree | 高 | 受入2、fail closed |
| C8 | 失敗・中断した Run の checkpoint: このレーンは成功フラグを持たず、呼ばれた時点のツリーを commit する（呼び出し側が Run の終わり・中断・lease 解放・正常終了で呼ぶ）。プロセス crash では呼べないので checkpoint は無い | 高 | 受入4、durability §3.3 |
| C10 | 空の作業ツリー（コミットもファイルも無い repo）→ checkpoint → git の空 tree を持つ commit ができ、pack が返る | 中 | 受入1、境界 |
| C9 | 全変更 → `npm run check` → exit 0 | 高 | Result |

C8 はこの層ではテストしない。checkpoint は Run の成否を受け取らず、呼ばれた時点で常に commit を作る（失敗専用の分岐が無い）。失敗・中断で呼ぶのは Workspace DO / Session DO 側の責務で、0157 / 0162 のオーケストレーションで固定する。プロセス crash は §3.3 のとおり checkpoint を打つプロセスが死ぬため対象外。

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1 | 状態遷移（変更・追加・削除） | integration（実 git） | `test/integration/checkpoint.test.ts` "commits the working tree without moving the user's refs" |
| T2 | C2 | 再送・競合（逐次 / 同時） | integration（実 git） | "re-running a checkpoint for the same run keeps the first commit" |
| T3 | C3 | 同値分割（含める / 除外する） | integration（実 git） | "leaves ignored, control, environment, and credential files out of the commit" |
| T4 | C4 | 状態遷移（run ごとの ref） | integration（実 git） | "keeps one checkpoint ref per run" |
| T5 | C5 | 契約（pack と git の互換） | integration（実 git + 空リポジトリ） | "returns a pack git can index and walk from the checkpoint commit" |
| T6 | C6 | 境界（root = work tree のサブディレクトリ） | integration（実 git） | "snapshots the workspace root, not the whole repository" |
| T7 | C7 | 失敗注入（不正 runId・git 管理外） | integration（実 git） | "refuses an invalid run id or a directory that is not a work tree" |
| T8 | C8 | — | 設計（テストしない） | 呼び出し側の契約。この層に成功フラグが無いことをレビューで確認する |
| T10 | C10 | 境界値（空の作業ツリー） | integration（実 git） | "checkpoints an empty workspace with git's empty tree" |
| T9 | C9 | ゲート | static / build | `npm run check` |

unit ではなく integration に置く理由: checkpoint は git の子プロセスと実リポジトリの object DB に対する操作で、単一プロセスの純粋関数として証明できない。モックの git で確かめると、実際の `index` / ref / pack の意味を落とす（docs/testing.md「process を要するものは integration」）。

## Design

- **commit の作り方**: 一時 index（`GIT_INDEX_FILE` を temp dir の実在しない path に向ける）に `git add -A -- .` し、`git write-tree` → `git commit-tree`。ユーザーの index・HEAD・ブランチ・stash は触らない。commit は parent を持たない（root commit）。pack を snapshot の閉包だけに保ち、ユーザーの履歴を R2 に運ばないため。
- **untracked の範囲と除外**: 追跡済み + untracked のうち git が無視しないもの全部。削除済みの追跡ファイルは tree から消える（作業ツリーの写像）。`.gitignore` は git がそのまま適用する。
  - **何を守るか**: `.gitignore` 対象（git が無視するもの全部）と、下の名前リストに一致する tracked / untracked の両方。tracked でも一時 index から落とすので、`.env` や `.hns/root.json` をコミットしてあるリポジトリでも snapshot に乗らない。
  - **何を守らないか**: 名前ベースの除去であり内容は走査しない。資格情報を別名のファイル（例: `config/prod.txt`）に置いた場合、`.gitignore` に無ければ含まれる。ディスク全体の secret 検出はこの層の契約ではない（0143 / 0168 の範囲）。
  - **名前リスト**（`checkpoint.ts` の1箇所）: 任意の階層の `.hns`（root 同一性と制御データ）、`.env` / `.env.*`、`.ssh` / `.aws` / `.gnupg`、`.netrc` / `.npmrc` / `.git-credentials` / `.htpasswd`、`id_rsa` / `id_dsa` / `id_ecdsa` / `id_ed25519`、`*.pem` / `*.key` / `*.p12` / `*.pfx` / `*.jks` / `*.keystore`、`credentials.json` / `secrets.json` / `secrets.yaml` / `secrets.yml` / `secrets.toml`、`node_modules`。理由は追記のとおりで、hide は sandbox 内の見え方にすぎず、root を丸ごと snapshot に載せると資格情報が R2 に運ばれる。`node_modules` は untracked のまま巨大な tree を1つの pack に載せないための上限。
- **ref と冪等**: `refs/hns/checkpoints/<runId>`。runId が冪等キー（Run 1つにつき checkpoint は1つ）。既に ref があればその commit を返し（`created: false`）、新しい commit を作らない。無ければ `git update-ref <ref> <commit> ""` の CAS で進める（空の old は「存在しないこと」の要求）。競合したら勝った ref を読み直して返す。同じ runId の再実行・同時実行で ref は二重に進まない。
- **commit の決定性**: author / committer は `hns <hns@example.com>`、日時は注入可能（既定は現在時刻）。同じツリー・同じ日時なら同じ commit id。CAS の敗者が出す dangling commit は同じ id になるか、参照されないだけ。
- **失敗・中断**: checkpoint は Run の成否を受け取らない。Run の終わり・中断・キャンセル・lease 解放・SIGTERM の後始末で呼ぶ（durability §3.3）。crash では呼ぶプロセスが死ぬので checkpoint は無く、U は durable でない（§1 の process crash 行）。git の失敗は `CheckpointError`（`not-a-work-tree` / `invalid-run-id` / `git-failed` / `missing-object`）で返し、ref を進めない。
- **戻り値と境界**: commit・ref・pack の bytes・store key（`checkpoints/<commit>.pack`）を返す。R2 への put と watermark の書き込みはしない。0157 / 0162 が `head` → `put` → `POST /rpc/journal/watermark` を順に呼ぶ。R2 に既に key があれば put しない（0153 の `head` と同じ規則）。
- **パッケージ境界**: `@hns/workspace/checkpoint` の subpath export。Node の `child_process` / `fs` を使うため root entry（Worker が import する）には出さない。`./sandbox` / `./objects` と同じ形。
- **既知の限界**: submodule の commit は superproject に無いことがあり、その場合は `missing-object` で fail closed（部分的な pack を作らない）。内容ベースの secret 検出はしない。保持 / GC は 0168。

## Notes

- git の object model を CAS として使う。差分転送と dedup が無料でついてくる。
- 0153 の R2 key はこの commit から辿れる object。

## 追記（0127 の sandbox 調査、2026-11-17）

- checkpoint から `.hns`・secret・`.env` を除外する。root を丸ごと保存すると、hide していても資格情報が snapshot に乗る（[agent-sandbox-designs.md](../research/agent-sandbox-designs.md) R8）。

## やらないこと

- ユーザーの commit / push。
- merge / rebase の支援。

## Result

- verdict: **PASS**（reviewer-0154、blocking 0）
- reviewer: reviewer-0154（この変更を書いていない別エージェント）
- HEAD: 88764a5（rebase 後。main に ff 統合）
- 受入: 6/6。`npm run check` exit 0（605 tests / 106 files、34.4s。既知の cf dev inspector 9229 flake は再実行で green。隠していない）
- 確認: 一時 index + git add -A → write-tree → parent なし commit-tree、refs/hns/checkpoints/<runId> は update-ref の CAS。既存 ref は created:false で既存 commit、同時 2 回でも ref 更新 1 回。tracked の .env / .hns も git rm --cached で除外（名前ベース。内容は走査しないと明記）。pack は rev-list --objects の closure から作り、index-pack → cat-file -e / rev-list の集合一致、commit 1 個。ユーザーの HEAD / index / worktree は不変。author / 日時を固定。@hns/workspace/checkpoint の subpath で root entry に node: を入れない。
- 非 blocking（低 8、follow-up）: submodule は gitlink のみで内容を含まない（文言の修正）/ git rm --cached による dangling blob（add 時点の pathspec 除外が望ましい）/ docs/packages に ./checkpoint が無い・Log の C1–C9 表記 / TSDoc の issue 番号 / resolveRoot が ENOENT も not-a-work-tree に丸める / committedAt の検証順と RangeError が型付き失敗でない / 決定性の直接テストが無い / readRef が全エラーを「ref なし」にする。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions/D047.md) の採用を受けて）。
- 2026-11-17: 0153（R2）と 0169（watermark）が main に入ったので lead が `next` から `now` へ。design agreed・依存充足のため着手。
- 2026-11-17: テスト条件（C1–C9）・テスト設計（T1–T9）・Design を追加。touches を実装に合わせた: テストは vitest の include 外（`test/` 直下）なので `test/integration/checkpoint.test.ts`、加えて `package.json` の `./checkpoint` export、`tsdown.config.ts`、README。
- 2026-11-17: 実装。`packages/workspace/src/checkpoint.ts` で一時 `GIT_INDEX_FILE` に `git add -A` → 除外 pathspec を `git rm --cached` → `write-tree` → parent なしの `commit-tree`。`refs/hns/checkpoints/<runId>` は既存なら `created: false` で返し、無ければ pack を作ってから `update-ref` の CAS で進める。返すのは commit / ref / pack bytes / `checkpoints/<commit>.pack`。除外は `.hns`・`.env` / `.env.*`・資格情報名・`node_modules` で、tracked にも効く（一時 index から落とす）。`@hns/workspace/checkpoint` の subpath export にし、root entry / Worker bundle に Node の import を出さない。実 git の integration 8 本（作業ツリーとユーザー ref の不変、再実行と同時実行の冪等、tracked の除外、run ごとの ref、pack の `index-pack` と closure、空の作業ツリー、不正 runId / 非 git、サブディレクトリ root）。`npm run check` exit 0（605 tests / 106 files）。独立レビュー待ち。
- 2026-11-17: 再実行時に `server-integration` の cf dev harness（`gateway/budget`、`session-do`）が wrangler inspector proxy の socket 衝突（`Address already in use (socket "direct:1:default")`）で intermittent に落ちた。workspace の変更を含まない `server-integration` 単独でも 2 回中 1 回再現したため、このレーンの回帰ではない（cf dev を並列に起動する既存 harness の flake）。最終の `npm run check` は green。
- 2026-11-17: reviewer-0154 PASS（blocking 0）。main へ ff 統合（88764a5）。統合後の main gate は 1 回目が同じ inspector flake で test 段が落ち、再実行で exit 0（605 tests）。
