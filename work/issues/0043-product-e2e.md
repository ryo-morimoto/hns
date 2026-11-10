# 0043: 製品の E2E テスト

status: open
priority: plan
depends-on: 0102, 0145, 0146, 0159, 0178
touches: e2e/, docs/test/e2e.md, docs/testing.md, package.json, package-lock.json, .github

## Goal

主要なユーザージャーニーを、実ブラウザ + 実サーバで検証する。ツールは Playwright、テスト名をジャーニー名にする。
E2E は単体・結合・契約で代替できないものだけに絞る。

## Acceptance criteria

### Phase 1: ハーネスとスモーク

- [ ] Playwright を exact pin し、e2e/ に harness（pages / fixtures / journeys）を置く
- [ ] ローカルの Workers ランタイム + 実 D1/DO + Vite UI を起動する
- [ ] passkey の仮想オーセンティケータと storageState を用意する
- [ ] 3本のスモーク（ログイン、会話の送信、ファイル編集）を通す
- [ ] 失敗時に trace / video / screenshot / サーバログを保存する
- [ ] npm run test:e2e を追加し、npm run check には入れない
- [ ] CI の別ジョブで動かす（0041 の後。それまでは npm run test:e2e）

### Phase 2: 主要ジャーニー

- [ ] 会話のストリーミングと中断
- [ ] 会話の一覧・改名・削除
- [ ] 古い版の書き込みで競合表示
- [ ] Workflow 実行と human 入力
- [ ] Automation トリガー → 実行
- [ ] 複数マシンの状態表示
- [ ] WS 切断 → 再接続
- [ ] 未認証・越権アクセスの拒否

## Notes

- テスト名はユーザーに見える振る舞いで書く（Gherkin は使わない）。
- 外部 provider だけ faux。内部境界はモックしない。
- 各テストは一意の workspace / user を作り、API で seed する。UI でセットアップしない。
- sleep を使わず、WS の終端イベント / web-first assertion で待つ。
- PR はスモーク3本、main / nightly で全部。retry は診断用に限り、flake は quarantine。
- 複数オリジン・複数タブ・trace が必要なので Playwright を選ぶ。
- Phase 1 は 0102 / 0145 / 0146 / 0159 / 0178 を待つ。Phase 2 の Workflow / Automation は 0038、複数マシンは 0147 / 0148、認証の再編は 0158 を待つ。
- CI の別ジョブは 0041 の後。それまでは `npm run test:e2e` をローカルと手動で回す。

## やらないこと

- mobile / cross-browser（最初は Chromium だけ）
- pixel diff / visual regression（0114 の範囲）
- npm run check への E2E 追加

## Log

- 2026-11-10: 更新（user）。Playwright、テスト名で進める。Phase 1（ハーネス + スモーク）と Phase 2（主要ジャーニー）に分ける。
