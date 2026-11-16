# 0125: File tree と file search API

status: open
priority: next
design: agreed
design-ref: D089
depends-on: 0033, 0127, 0147, 0148
touches: packages/workspace/src, packages/machine/src/, packages/machine/test/, packages/machine/package.json, packages/core/src/graphql/, packages/core/test/graphql/, packages/server/src/graphql/, packages/server/test/graphql/, package-lock.json

## Goal

Editor が大きなワークスペースでもファイルを探せるようにする。
平らな一覧ではなく、rooted な tree と検索を返す。

## Acceptance criteria

- [ ] `Query.files` / `Query.fileSearch` が path 順で返す。tree は 1 dir / call、limit + nextCursor
- [ ] search は path の部分一致、limit 1–200、nextCursor
- [ ] metadata（`.git` / `.hns` 等）は常に隠す。既定セット + `.gitignore` + `includeIgnored`。dotfiles は gitignored でなければ出す
- [ ] path は project root 配下。symlink は追わない。`..` は拒否
- [ ] 読めないディレクトリは error にせず、その階層だけ `skipped`（理由付き）で返す
- [ ] テスト: 境界、symlink、既定除外、.gitignore、includeIgnored、深い階層、大量ファイル

## Notes

- 0106 の Editor が使う。tree / search は GraphQL、content は 0157 の REST
- 検索は path のみ。本文 grep は別 issue（必要になったら）
- パスの正規化は workspace の既存 helper を使う。再実装しない

## 追記（0127 / machine、2026-11-17）

- machine の既存 op は health / stat / read / list。tree は list / stat で足りるが、**search は新しい op** が要る。
- path は `projectRoot` と `path` を別々に送り、machine が R3 で解決する（[agent-sandbox-designs.md](../research/agent-sandbox-designs.md)）。
- 兄弟 project は tmpfs の外なので返らない。

## Design（D089 で合意）

2026-11-17 / ユーザーの設計レビューで合意（D089）。

### 前提

- 面は **tree / search = GraphQL、content = REST**。D077 の files を分ける（承認時に DNNN で記録）。0125 は tree / search、0157 は content。
- 0127（D080）: project は信頼境界。path はマシン ROOT からの相対で、`projectRoot` と `path` を別々に送り、マシンが R3（`openat2` / component walk）で解決する。
- machine の既存 op は health / stat / read / list。**search は新しい op**。write は 0157。
- Worker は fs を持たない。tree / search はマシンで実行し、Worker は認可と中継だけを行う。

### 決定 1: 面は GraphQL（tree / search）、content は REST

- `Query.files(projectId, path, limit, after)` と `Query.fileSearch(projectId, q, limit, after)`。返り値は `FileList = FileListOk { entries, nextCursor, skipped } | QueryFailure`。
- 認証は `/graphql` の session。`projectId` の存在と所有を D1 で確かめ、project root を引く。
- `path` は project root からの相対 POSIX パス。lexical 検査（先頭 `/`、`..`、`.`、空 segment、`\\`、NUL、`.hns`、長さ）は早期拒否で、**security 境界はマシンの R3**。
- 本文（content）は GraphQL に載せない。0157 の REST（大きな本文・バイナリ・ETag）に残す。**D077 の files を tree / search = GraphQL、content = REST に分ける**（承認時に DNNN で記録）。
- `FileEntry` / `FileList` は **server 側の payload 型**（`ConversationList` と同じ）。core のモデルには載せない。`schema.graphql` は codegen で再生成する。
- tree は path ごとの field call。Relay の store は引数で分かれ、大きなディレクトリの続きは `nextCursor` で取る。Connection 型は作らない（既存の payload と揃える）。
- 既存の `GET /api/files` は製品に無い（PoC のみ）。互換のためには作らない。

### 決定 2: tree は1ディレクトリずつ（lazy）

- `path` の直下だけを返す。`limit` は 1–500、`nextCursor` で続きを返す。UI はディレクトリを展開したときに呼ぶ。
- 返り値は `{ entries: [{ name, path, kind: "file" | "directory" | "symlink" }], nextCursor, skipped: [{ name, reason }] }`。path 順。
- 再帰 depth の一括取得はしない（巨大ディレクトリで応答と machine の負荷が跳ねる）。必要になったら `depth` を足す。

### 決定 3: search は machine の新しい op

- `search({ projectRoot, path, q, limit, cursor })`。machine が project root 配下を bounded walk し、path の部分一致を返す。
- 上限: 走査 20,000 entry / 1 秒 / 深さ 32。結果は path 順、`limit` 1–200、`nextCursor`。
- metadata / 既定除外 / gitignored / symlink は走査しない（同じ規則）。ループを作らない。

### 決定 4: 除外と symlink（U-03 の提案）

- **metadata は常に隠す**: `.git` / `.hns` / `.svn` / `.hg` / `.jj` / `.sl`。toggle でも出さない。list / search / content で拒否する。
- **既定の除外（UX）**: `node_modules` / `bower_components` / `dist` / `build` / `out` / `.next` / `.nuxt` / `.cache` / `target` / `.venv` / `venv` / `__pycache__` / `.pytest_cache` / `.mypy_cache` / `coverage` / `.turbo` / `.gradle`。定数。
- **`.gitignore` を尊重**: root が git repo のとき、入れ子の `.gitignore` と `.git/info/exclude`。global（`core.excludesFile`）は使わない（マシン依存で再現しない）。
- **dotfiles は隠さない**: `.github` / `.gitignore` / `.editorconfig` / `.env` は、gitignore されていなければ見える。
- **`includeIgnored`（既定 false）**: 既定除外と gitignored を表示する。metadata は常に隠す。
- symlink は **追わない**。tree では `kind: "symlink"`、search では出さない。展開・読みは拒否。
- 兄弟 project はマシンの `--tmpfs <ROOT>` の外なので見えない。
- 調査: `work/research/file-tree-filtering.md`（VS Code / Claude Code / ripgrep / JetBrains / ignore）。

### 決定 5: 失敗は GraphQL の union

- 期待失敗は union（HTTP 200）: `invalid_argument` / `not_found` / `forbidden` / `unavailable` / `timeout`。要求自体が解決不能（構文・検証）なら 400。
- 読めないディレクトリは全体を error にせず、`entries` と `skipped: [{ name, reason: "permission_denied" | "io_error" }]` で返す（AC）。
- machine の失敗（root_not_found / root_outside / root_symlink / path_outside）を union の reason に写す。

### 決定 6: 依存

- `depends-on` から 0157 を外す（listing は content の版付き経路を使わない）。0033 / 0127 / 0147 / 0148 のまま。
- 0157 と同じ R3 の解決を使う（実装は machine の共通 helper）。

### 決定（D089）

| ID | 論点 | 決定 | 影響 | 決める時 |
| --- | --- | --- | --- | --- |
| U-01 | tree を lazy にするか depth 一括か | **決定（user）**: lazy（1 dir / call、limit + cursor） | 0106 | 2026-11-17 |
| U-02 | search を machine の新 op にするか | **決定（user）**: 新 op（bounded walk） | 0147 / 0157 | 2026-11-17 |
| U-03 | 除外の既定 | **決定（user）**: metadata は常に隠す + 既定セット + .gitignore + `includeIgnored`。dotfiles は隠さない | 0106 / 0157 | 2026-11-17 |
| U-04 | symlink の表現 | **決定（user）**: `kind: "symlink"`、追わない | 0106 | 2026-11-17 |
| U-05 | tree / search を GraphQL にするか | **決定（user）**: する。content は 0157 の REST に残す | 0106 / 0157 | 2026-11-17 |

### テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | 1 ディレクトリを tree → 直下だけが path 順で返る | 高 | 受入1 |
| C2 | 大量の entry → limit + cursor → 重複・欠落なく続きが返る | 高 | 受入1・4 |
| C3 | `.git` / `.hns` / `node_modules` / gitignored → tree / search に出ない。`includeIgnored` で既定除外と gitignored が出る。dotfiles は（gitignored でなければ）出る | 高 | 受入2 |
| C4 | symlink（外を指す）→ tree は kind symlink、search に出ない。展開・読みは forbidden | 高 | 受入3 |
| C5 | `..` / 絶対 / NUL / `.hns` → `invalid_argument` union。存在しない path → `not_found` | 高 | 受入3 |
| C6 | 読めないディレクトリ → 200 で entries + skipped（reason） | 中 | 受入5 |
| C7 | search の部分一致 → path 順、limit 200、cursor | 高 | 受入2・4 |
| C8 | machine 不達 / timeout → union の `unavailable` / `timeout` | 高 | 受入1・2 |
| C9 | project A / B の同じ相対パス → 別の root を読む（混ざらない） | 高 | D080 |
| C10 | `npm run check` | 高 | 受入6 |

層は unit（path / filter / cursor / error 写像）、integration（machine の実 HTTP fixture で tree / search）、GraphQL の契約テスト。実マシンの fs は 0147 / 0194。

## Log

- 2026-11-17: D089 で合意。U-01〜U-05 を決定し、`design: agreed` にした。

## やらないこと

- ファイル本文の検索 / 置換
- Git の status / diff
