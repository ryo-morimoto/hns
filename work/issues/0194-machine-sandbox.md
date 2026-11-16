# 0194: machine の sandbox・hide・env 純度（0147 から分割）

status: open
priority: plan
depends-on: 0147
touches: packages/machine/, packages/machine/test/security/

## Goal

0147 のうち、環境依存で重い受入条件（bwrap・hide・実機確認・env 純度）を引き取る。
0147 は署名・パス封じ込め・上限に絞り、fixture で検証できる形のまま先に統合する。

## Acceptance criteria

- [ ] `exec` は bwrap 経由。sandbox が無ければ exec を出さない（fail closed）
- [ ] `~/.config/hns` と `.git` の書き込みを拒否し、`~/.config/hns` は読み取りも hide で隠す（0052 を起動時に配線）
- [ ] hide した `~/.config/hns` からデバイス鍵・cloudflared token が読めないことを実機で確認（bwrap 無しは SKIP）
- [ ] machine の env / process に provider 鍵・provider URL が無いことをテストする（harness 側は 0151）
- [ ] ROOT の同一性（`.hns/root.json`）を起動時に確認し、違えば拒否する
- [ ] `npm run check` が通り、独立レビューが PASS する

## テスト条件

| ID | 条件（Given → When → Then） | リスク | 出所 |
| --- | --- | --- | --- |
| C1 | bwrap が無い環境 → exec → 実行せず拒否（SKIP ではなく拒否） | 高 | 受入1 |
| C2 | `~/.config/hns` を指すパス → read → 中身が返らない | 高 | 受入2・3 |
| C3 | `.git` 配下 → write → 拒否 | 高 | 受入2 |
| C4 | machine の env → provider 鍵と URL を探す → 無い | 高 | 受入4 |
| C5 | root の marker が違う → 起動 → 拒否 | 中 | 受入5 |
| C6 | 全変更 → `npm run check` → 通る | 高 | 受入6 |

## テスト設計

| ID | 条件 | 技法 | 層 | テスト |
| --- | --- | --- | --- | --- |
| T1 | C1–C3 | 境界値 + 実機 | integration | `packages/machine/test/security/`（bwrap 無しは明示 SKIP、C1 のみ拒否を固定） |
| T2 | C4 | 環境の固定 | unit | env の構築関数に対する assertion |
| T3 | C5 | 故障注入 | unit | marker の差し替え |
| T4 | C6 | ゲート | static / build | `nix develop --command npm run check` |

## Notes

- 分割の理由: 0147 の署名・パス・上限は fixture で検証でき、実 HTTP のテストも回せる。bwrap と hide は
  実行環境に依存し、SKIP が混ざるためレビューが長引く。先に 0147 を統合して 0148 / 0157 を開く。
- PoC: `work/poc/cf-harness/agent/server.mjs`。hide の配線は 0052 の内容をここで受ける。
- 0151 と合わせて「鍵が machine と harness のどちらにも無い」ことを示す。

## やらないこと

- 署名・nonce・時刻窓・パス封じ込め・上限（0147）。
- Windows / macOS の sandbox（0006 の範囲外）。
- machine の登録（0148）。

## Log

- 2026-11-11: 作成。0147 から環境依存の受入条件を分割。
