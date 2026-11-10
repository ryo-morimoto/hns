# 0012: 実 Provider（Ollama Cloud）

status: done
depends-on: —
touches: work/poc/conversation/ollama.mjs, work/poc/conversation/real.mjs

## Goal

鍵のある実モデルで、faux と同じツール経路を1往復させる。

## Acceptance criteria

- [x] Ollama Cloud に接続できる
- [x] モデルが `read_file` / `write_file` を呼び、Workspace の版チェックを通る
- [x] 変更がファイルに残る

## Result

`gpt-oss:120b` で 2 ツール呼び出し、3.3 秒、`OK`。
`qwen3-coder:480b` は退役（410）。鍵は `~/.config/hns/ollama.key`。
詳細は [research](../research/ollama-cloud.md)。T-08 は 1 プロバイダのみ。
