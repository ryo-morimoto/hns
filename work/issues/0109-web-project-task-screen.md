# 0109: Project / Task 画面

status: open
priority: plan
design: pending
depends-on: 0102, 0127
touches: packages/web/src/screens/projects, packages/web/src/screens/tasks, packages/web/test/projects, packages/web/test/tasks

## Goal

Project と Task を一覧・作成・改名・状態変更できる。
Task は backlog であり、0116 の WorkItem が入ったら会話/run とリンクする。

## Acceptance criteria

- [ ] Project 一覧、作成、改名。現在の Project を URL / サイドバーと同期
- [ ] Task 一覧、作成、title 変更、status（todo / doing / done / blocked）
- [ ] filter（project / status）と、空 / loading / error
- [ ] status 変更は Undo。失敗時は元に戻す
- [ ] 0116 が入ったら、task から関連する conversation / run を開ける（それまでは非表示）
- [ ] テスト: CRUD、filter、Undo、エラー

## Notes

- Project の削除 API は無い。UI にも出さない
- Task の削除 API は無い。status で表現する
- 0116 のリンクを先回りしてダミー表示しない

## やらないこと

- Workflow / Automation（0110–0112）
- 一括選択 / 一括変更（必要になったら別 issue）
