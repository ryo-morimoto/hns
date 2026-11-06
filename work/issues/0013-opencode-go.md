# 0013: 2プロバイダ目（OpenCode Go）と API 方式の比較

status: done
depends-on: 0012
touches: work/poc/conversation/opencode.mjs, work/research/opencode-go.md

## Goal

T-08「最小2種の正式API方式」を満たす。別プロバイダ・別API方式で同じツール経路を通す。

## Acceptance criteria

- [x] OpenCode Go に接続できる（`~/.config/hns/opencode-go.key`）
- [x] openai-completions 方式でツールが動く
- [x] anthropic-messages 方式でツールが動く
- [ ] google-generative-ai 方式（403、アカウント権限なし）

## Result

`deepseek-v4.1-flash` と `qwen3.8-max` で 2 ツール呼び出し・ファイル更新・OK。
`gemini-4-argon` は `Model access is disabled`。詳細は [research](../research/opencode-go.md)。
T-08 は 2 プロバイダ・2 API 方式で達成。google 系は権限待ち。
