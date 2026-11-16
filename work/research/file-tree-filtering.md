# ファイルツリーの除外規則（0125 U-03 の調査）

2026-11-17 / 調査: lead。目的は「既定の除外で初期体験を上げ、除外の取りこぼしを減らす」。

## 既製品の既定

| 製品 | tree（explorer）の既定 | search | .gitignore | dotfiles | トグル |
| --- | --- | --- | --- | --- | --- |
| VS Code | VCS / OS の定型（`.git` `.svn` `.hg` `CVS` `.DS_Store` `Thumbs.db`）を隠す。`node_modules` は explorer には出る | 既定で `.gitignore` / `.ignore` を尊重（`search.useIgnoreFiles` = true）。`search.exclude` が `node_modules` 等を隠す | explorer は既定で出る（`explorer.excludeGitIgnore` = false） | 隠さない（VCS/OS 以外） | `files.exclude` を workspace / user で変更 |
| Claude Code | `@` の file picker は `.gitignore` を尊重（`respectGitignore` = true） | 同 | 既定で尊重 | 隠さない（VCS 以外） | 設定で off |
| ripgrep | `.` 始まりは既定でスキップ。`--hidden` で含める | `.gitignore` / `.ignore` を尊重 | 既定で尊重 | 既定で隠す | フラグ |
| JetBrains | Excluded フォルダは index から外す。既定で project view に出ない | index から外す | 尊重（index） | 隠さない | 「Show Excluded Files」 |
| GitHub code search | — | すべてを index しない（.gitignore の扱いは明示なし） | — | — | — |

補足: `ignore` npm パッケージ（eslint 等が使用）が gitignore の規則（`!` の否定、`dir/`、入れ子）を実装している。

## わかったこと

- VS Code の explorer は **gitignore されたものを既定で出す**（検索は隠す）。エージェントの作業画面としては `node_modules` が最初から見えるのは重い。
- Claude Code / ripgrep は **gitignore を既定で尊重**する。エージェントの file picker の体験に近い。
- **dotfiles を一律に隠す製品は無い**。`.github` / `.gitignore` / `.env` は編集対象になる。
- 除外は「表示」と「検索」で別の既定を持てる（VS Code）。hns はまず tree と search を同じ規則にし、必要なら分ける。

## 提案（0125 の既定）

1. **metadata は常に隠す**: `.git` / `.hns` / `.svn` / `.hg` / `.jj` / `.sl`。toggle でも出さない。list / search / content で拒否する（fail closed）。
2. **既定の除外（UX）**: `node_modules`、`bower_components`、`dist`、`build`、`out`、`.next`、`.nuxt`、`.cache`、`target`、`.venv`、`venv`、`__pycache__`、`.pytest_cache`、`.mypy_cache`、`coverage`、`.turbo`、`.gradle`。定数で持ち、プロジェクトから変えない（v1）。
3. **`.gitignore` を尊重**: root が git repo のとき、入れ子の `.gitignore` と `.git/info/exclude` を読む。global（`core.excludesFile`）は使わない（マシン依存で再現しない）。
4. **dotfiles は隠さない**: `.github` / `.gitignore` / `.editorconfig` / `.env` は、gitignore されていなければ見える。
5. **`includeIgnored`（既定 false）**: 2 と 3 を表示する。metadata は常に隠す。UI は「除外を表示」のチェックボックス。
6. **非 git プロジェクト**: 1 と 2 だけ。
7. **search も同じ規則**。本文 grep はしない（0125 の範囲外）。

## 実装

- 判定は machine 側。`ignore` を exact pin で足し、`list` / `search` の walk で `.gitignore` を読む。
- 既定パターンは `@hns/workspace` の定数（純粋なデータ）。`.gitignore` の読み込みは machine。
- 走査の上限（20,000 entry / 1 秒 / 深さ 32）は 0125 のまま。除外の判定で上限を超えない。
- content（0157）も `.git` / `.hns` を拒否する（エディタから metadata を開けない）。

## 初期体験

- ルートを開くと README / src / package.json が見え、`node_modules` / `dist` / `.git` は見えない。
- `.env` は gitignore されていなければ見え、されていれば「除外を表示」で出る。
- 大規模 repo でも最初の 1 画面が軽い（lazy tree + 既定除外）。

## 出典

- [VS Code の files.exclude / search.exclude / useIgnoreFiles / excludeGitIgnore](https://errcodex.com/config/vscode/files-exclude/)（2026-10 更新の整理。VS Code 公式の設定ページを参照）
- [Claude Code settings（respectGitignore、既定 true）](https://code.claude.com/docs/en/settings)
- [ripgrep README（gitignore と hidden）](https://github.com/BurntSushi/ripgrep)
- [ignore（gitignore 規則の実装）](https://www.npmjs.com/package/ignore)
- [JetBrains の Show Excluded Files](https://intellij-support.jetbrains.com/hc/en-us/community/posts/207297985-Can-t-see-excluded-folders)