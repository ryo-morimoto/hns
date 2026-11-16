# 0110: Workflow / Run 画面（一覧・開始・human 入力）

status: open
priority: plan
design: pending
depends-on: 0038, 0102, 0129, 0159
touches: packages/web/src/screens/workflows, packages/web/src/screens/runs, packages/web/test/workflows, packages/web/test/runs

## Goal

Workflow の一覧、run の開始、run の状態とノード、human ノードへの入力を行う。
グラフの作成・編集は 0111 に分ける。

## Acceptance criteria

- [ ] Workflow 一覧（project で filter）、run 一覧（workflow で filter）
- [ ] run 開始（input）と、run の status / node 進捗
- [ ] waiting ノードに入力を返し、run を再開。入力は複数行
- [ ] completed / failed / waiting / running / queued の表示
- [ ] ノードの conversation_id から会話を開く（登録済みのとき）
- [ ] 0118 の SSE / 再取得で run の状態が更新される
- [ ] テスト: 開始、入力、状態、error、empty

## Notes

- 0115 の overview は Needs you に waiting/failed を出すが、run の詳細はここ
- run の output は JSON text。UI で parse するのは表示のためだけにし、型を仮定しない
- 実行者は agent。UI から tool を直接実行しない

## やらないこと

- グラフ編集（0111）
- Automation からの run 作成（0112）
