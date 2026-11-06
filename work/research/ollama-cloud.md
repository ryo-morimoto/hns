# Ollama Cloud 実測

2026-11-06 / T-08 の1件目。鍵は `~/.config/hns/ollama.key`（`OLLAMA_API_KEY` でも可）。

## 事実

- エンドポイント: `https://ollama.com/v1`（OpenAI 互換）、モデル一覧は `/v1/models` と `/api/tags`。
- 認証は `Authorization: Bearer <key>`。不正キーは 401、退役モデルは 410 が返る。
- **qwen3-coder:480b は 2026-07-15 に退役**（410、`glm-5.3-flash` を案内される）。
- 使える: `gpt-oss:120b`、`glm-5.3`、`deepseek-v4.1-flash`、`kimi-k3`、`minimax-m3` など。tools 対応は `/api/tags` の `capabilities` で確認できる。

## 1往復の結果（gpt-oss:120b）

- お題: 「a.txt を読んで、読んだ版で 'hello from ollama' に置換して」
- ツール: `read_file` → `write_file`（2回）。`applied` でファイル更新。
- 所要: 2.1〜3.3 秒。thinking 付きで返る。
- 実行: `OLLAMA_MODEL=gpt-oss:120b node work/poc/conversation/real.mjs`

## 未確認

- 2つ目の Provider（正式な OpenAI / Anthropic / Google）との互換比較。
- ストリーミングの体感、長い文脈、レート制限。
- モデルごとの contextWindow / maxTokens（今は 256k / 32k の仮値）。
