# OpenCode Go 実測

2026-11-06 / T-08 の2件目。鍵は `~/.config/hns/opencode-go.key`。

## 事実

- pi-ai の `opencodeGoProvider` をそのまま使える。モデル一覧は models.dev 由来で 30 程度。
- `openai-completions` / `anthropic-messages` / `google-generative-ai` / `openai-responses` の4方式を 1 プロバイダで提供。

## 1往復の結果

| モデル | API | 結果 | 時間 |
| --- | --- | --- | --- |
| `deepseek-v4.1-flash` | openai-completions | **OK**（read → write、2ツール） | 7.6s |
| `qwen3.8-max` | anthropic-messages | **OK**（read → write、2ツール） | 7.1s |
| `gemini-4-argon` | google-generative-ai | **403 Model access is disabled** | 0.3s |

## 分かったこと

- **2プロバイダ・2API方式**でツール呼び出しが通った（Ollama Cloud = completions、OpenCode Go = completions / anthropic-messages）。
- アカウントの権限で使えないモデルがある（gemini-4-argon）。API 方式の互換と、モデル単位の利用可否は別。
- 同じプロンプトで Ollama 2〜3秒、OpenCode 7秒前後。thinking の有無とモデルサイズの差と思われる。

## 未確認

- google-generative-ai 方式の実動作（権限が付いたモデルで再試行）。
- openai-responses 方式。
- レート制限・長い文脈・ストリーミングの体感。
