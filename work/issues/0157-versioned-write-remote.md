# 0157: 版付き書き込みのリモート化（ack が DO を通る）

status: open
priority: next
design: agreed
design-ref: docs/durability.md §3.1・§3.4
depends-on: 0033, 0147, 0156
touches: packages/workspace/src/files.ts, packages/server/src/do/workspace.ts, packages/server/src/files/content.ts, packages/server/test/files/

## Goal

読み書きの経路を UI → DO → マシンにし、ack の時点で Journal と内容が確定している形にする。
TOCTOU の閉じ方（dirfd・同一ディレクトリ temp + rename）はマシン側で維持する。

**読みはマシンから返す**（R2 は読みの経路に入れない。U が見えないため）。オフラインは失敗させる。

## Acceptance criteria

- [ ] `POST /workspaces/:id/files` が DO で intent を書き、マシンで適用し、outcome を書いてから 200 を返す
- [ ] `expectedVersion` はマシンで再計算して比較（DO の値を信じない）
- [ ] 応答が返らないときは `unknown`。再送で照合（INV-04）
- [ ] concurrent な保存で片方が conflict になるテスト
- [ ] 保存の p95 を記録（目標を決める）
- [ ] 読みはマシンから。切断中は「読めない」を返し、古い内容を返さない
- [ ] 外部変更（agent の shell）を検知したら、版の不一致として扱い UI に出す

## Notes

- ack が DO を通るので、ローカル fsync に依存せずに RPO 0 を満たせる。
- ただし git / bash 由来の変更はここを通らない（checkpoint 0154）。
- 0156 の `apply` は intent / outcome を持たず、再送は conflict を返す。ここで intent / outcome に拡張し、再送は記録済みの outcome を返す（INV-04）。
- 面（REST / GraphQL）は 0182 の棚卸しで決まる。AC の `POST /workspaces/:id/files` は暫定のパスで、実装時に確定する（D059）。

## 追記（0127 の sandbox 調査、2026-11-17）

- machine の op は health / stat / read / list のみ。**write は 0157 が足す**。
- パスは `projectRoot` と `path` を**別々に**受け、machine が ROOT を dirfd で開いて `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` か component walk で解決する。`O_NOFOLLOW` は最終要素にしか効かない。
- `expectedVersion` の再計算は、この解決の後に行う。
- テスト: 中間 symlink / `..` / 兄弟 project を拒否する。
- 出典: [agent-sandbox-designs.md](../research/agent-sandbox-designs.md) の R3 / F3。

## やらないこと

- バッチ保存（0055）。

## Log

- 2026-11-07: 作成（[D047](../../docs/decisions.md) の採用を受けて）。
- 2026-11-17: 0156 の Result を受けて、intent / outcome への拡張をこの issue の範囲にした（touches に `do/workspace.ts`）。面は 0182 の棚卸しに従う。
