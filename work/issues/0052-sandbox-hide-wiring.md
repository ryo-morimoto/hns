# 0052: sandbox の hide を起動時に配線する

> 0147（マシンエージェント）の受入条件に統合（D047）。単独では着手しない。

status: superseded
depends-on: 0035
touches: packages/server, docs/safety.md, docs/workspace.md

## Goal

agent の bash から鍵ファイルを読めないようにする。0045 で `createSandboxEnv({ hide })` は用意したが、
呼び出し元がまだ無い（既定で空）。起動時の1箇所で隠すパスを渡す。

## Acceptance criteria

- [ ] 隠すパスの既定を決める（`~/.config/hns` は必須。`~/.ssh` などを足すかは判断）
- [ ] 0035 の起動処理で `createSandboxEnv({ root, hide })` を渡す
- [ ] sandbox 実機テストで、隠した場所から鍵が読めないことを確認（bwrap 無しは SKIP）
- [ ] `HOME` を root にしたことで壊れるツール（git / npm の設定）を確認し、必要ならエージェント用の
      home を分ける

## Notes

- `hide` は library の既定で空のまま。勝手にホームを隠すと、git の設定や npm のキャッシュも見えなくなる。
- 隠すのは読み取りだけではなく、ホーム全体を tmpfs にする選択肢もある（鍵だけでなく履歴も消える）。
- 同じパッケージ（packages/server）は 0035 と直列。

## やらないこと

- macOS / Windows の sandbox backend（0006 の範囲外）。
- `hide` を既定 ON にすること。
- ネットワークの遮断（今は残すと決めている）。

## Log

- 2026-11-07: 作成（0045 の H-1 の残り）。
