# 0174: ステージ内容と merge をゲートで覆う

status: done
depends-on: 0170, 0171
touches: .pre-commit-config.yaml, .githooks/, package.json, package-lock.json, tools/gate/select.ts, docs/decisions.md, AGENTS.md

## Goal

D051 で残した2つの穴を埋める。**未ステージの変更を混ぜずに index の内容だけを検査する**ことと、
**merge コミットを素通りさせない**こと。worktree の退避・復元は自作せず、prek に任せる。

## Acceptance criteria

- [x] pre-commit は index の内容だけを見る（未ステージ変更を退避してから実行し、終了後に戻す）
- [x] pre-merge-commit で同じゲートが走る（非 fast-forward の merge のみ）
- [x] 成功時も段階ごとの時間が出る（prek の `verbose: true`）
- [x] 追加依存は exact pin（`@j178/prek` 0.5.10）で、理由を D052 に記録
- [x] `npm run check` と既存のフック経路が通る

## Notes

- 実測（prek 0.5.10）: staged=B / worktree=C のときフックは B を見て、終了後に C へ戻す。
  `prek run --stage pre-commit` を .githooks から呼んでも同じで、shim のインストールは要らない。
- pre-merge-commit は `prek install` では既定で入らない（`default_install_hook_types` か `-t` が必要）。
  今回は `core.hooksPath=.githooks` のままなので install 自体を使わず、`.githooks/pre-merge-commit` から
  `prek run --stage pre-merge-commit` を呼ぶ。
- merge は commit と同じ段階（unit まで）。全量は pre-push が担う。
- 代償: フックの間だけ worktree が退避される（commit で約2.5秒）。同時編集があると復元が衝突し得るので、
  pre-commit を短く保つ。

## やらないこと

- prek の workspace モードや remote 機能は使わない（選別は `tools/gate` が持つ）。
- merge で integration や build は回さない（push の責務）。

## Result

- verdict: **PASS**
- reviewer: prek-reviewer
- HEAD: 937ae88
- blocking findings: なし（throwaway clone で「index の内容が見える」「失敗時も復元」「非 ff merge でフック」「exit code 伝播」を実行確認）
- not blocking: `.pre-commit-config.yaml` を stage しないままコミットすると止まる（意図した安全策。D052 に記載）。
  pre-push も全量の間 worktree を退避する（約20秒）。
