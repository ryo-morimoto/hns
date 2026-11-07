# 0171: build を pre-push に移す

status: done
depends-on: 0170
touches: .githooks/pre-push, tools/gate/stages.ts, tools/gate/main.ts, docs/testing.md, AGENTS.md

## Goal

build と knip をコミット前から外し、push 前に回す。型検査と重複する部分が大きく、コミットのたびに払う理由が薄い。

## Acceptance criteria

- [x] `.githooks/pre-push` を追加し、`gate pre-push` を呼ぶ
- [x] 段階表に `hooks` 列を足し、build と knip を `pre-push` にだけ割り当てる
- [x] `npm run check`（`--all`）は全段階のまま
- [x] 実測: pre-commit（core 変更）2.6s、pre-push 20.8s

## Notes

- pre-push は**全パッケージ**を対象にする。push は CI の直前の最後の砦なので、影響範囲の計算をせず確実に全部回す。
- `--all` は「全段階 + 全パッケージ」、`pre-push` は「全段階 + 全パッケージ」だが意図が違う（前者は手動、後者は hook）。
- build が型検査より多く捕まえるもの（declaration emit・exports と dist の一致・vite の bundle）は push 前に必ず走る。

## Result

- verdict: **PASS**
- reviewer: tier-reviewer（0170 と同じ変更としてレビュー）
- HEAD: d40ac8f
- blocking findings: なし
