# AGENTS.md

hns（複数マシンの AI Agent を、セルフホストの単一 UI から操作する）の作業規約。
**原則だけを書く。詳細は docs に置き、このファイルは短く保つ。**
サブディレクトリに AGENTS.md があれば、そちらが優先。

## 読むもの

毎回読むのは、このファイルと [CODING_STANDARDS.md](CODING_STANDARDS.md) だけ。あとは変更するコードの隣。

必要になったときだけ:

| いつ | 何 |
| --- | --- |
| 要件・スコープを確かめる | `README.md` |
| 境界・不変条件・構成を変える | `ARCH.md` / `docs/packages.md` |
| 設計判断の理由を知る・変える | `docs/decisions.md`（追記のみ） |
| ツール・型・CI を変える | `docs/engineering.md` |
| 型をレビューする | `docs/type-review.md` |
| golden example と比べる | `docs/typescript.md` |
| 対象の作業を選ぶ | `work/BOARD.md` / `work/issues/` |

残作業は `work/` に置く。

## コマンド

```bash
scripts/with-node.sh npm run check     # oxlint → oxfmt --check → tsc → test → build
scripts/with-node.sh npm test -w @hns/store
```

pre-commit は自動（初回だけ `scripts/install-hooks.sh`）。

`work/poc/` は過去の検証。製品コードではない。

## コードの規約

型・検証・安全・エラー・テスト・コメント・依存・チェックは [CODING_STANDARDS.md](CODING_STANDARDS.md)。
