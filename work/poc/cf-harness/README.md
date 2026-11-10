# Cloudflare harness PoC

pi-durable 1.5.0 の Harness を Cloudflare の Durable Object で動かし、実行環境だけを
手元のマシンに残したときの**形・レイテンシ・コストの当たり**を測る PoC。
製品コードではない（[AGENTS.md](../../../AGENTS.md) の work/poc 扱い）。

設定と配備は `wrangler` ではなく **`cf`**（Cloudflare の CLI、open beta）を使う。
設定は `cloudflare.config.ts`、Durable Object は `exports.durableObject({ storage: "sqlite" })`。

## 構成

```text
run.mjs ─ HTTP ─▶ Worker ─▶ Session (Durable Object)
                              ├─ pi-durable Harness（1.5.0、openDurableObjectSqliteStorage）
                              ├─ faux provider（4ステップの台本）
                              └─ RemoteEnv ─ HMAC 署名付き HTTP ─▶ agent/server.mjs
                                                                    └─ HNS_ROOT 配下の fs と bash
```

- 会話の正本・実行状態は **DO SQLite**
- ツールは上流の `CodingTools`（read / write / edit / bash）をそのまま使い、
  `HarnessOptions.env` にリモート実装を渡している
- マシン側エージェントは HMAC-SHA256 署名、時刻窓、nonce 再利用拒否、ROOT 封じ込めだけを持つ
- sandbox は**無い**（bwrap は製品側の話。ここでは測らない）

## 動かす

`nix develop` の中で、このディレクトリから:

```bash
./start.sh              # .dev.vars 生成、agent 起動、cf dev
node run.mjs            # 別ターミナルで計測
```

手で起動する場合:

```bash
# 1) マシン側
HNS_ROOT=../../../.work/cf-poc-root \
HNS_AGENT_SECRET=$(sed -n 's/^HNS_AGENT_SECRET=//p' .dev.vars) \
HNS_AGENT_PORT=8788 HNS_AGENT_DELAY_MS=0 node agent/server.mjs

# 2) Worker
npx cf dev --port 8787

# 3) 計測
TURNS=12 node run.mjs
```

### 実エッジを通す

quick tunnel なら Cloudflare の認証無しで経路を本物にできる。

```bash
# 別ターミナル
nix shell nixpkgs#cloudflared --command \
  cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
# 表示された https://....trycloudflare.com を渡して起動
HNS_AGENT_URL=https://....trycloudflare.com npx cf dev --port 8787
```

`HNS_AGENT_DELAY_MS` は 1 リクエストあたりの人工遅延。

## デプロイ

```bash
npx cf auth login                 # デバイスコード方式（URL とコードが出る）
HNS_AGENT_URL=https://... ./deploy.sh
```

`deploy.sh` は `cf deploy --secrets-file .dev.vars` を実行する（`HNS_AGENT_SECRET` を一緒に上げる）。
トンネルは `tunnel.sh`（remotely-managed tunnel のトークンが必要）。

## 実装した範囲

| ある | ない（製品で要る） |
| --- | --- |
| DO SQLite 永続化、alarm による wake/resume | lease / fencing、複数マシン、D1 投影 |
| 4 ステップの faux 台本 | 実プロバイダ、provider gateway、予算上限 |
| read / write / edit / bash（上流の実装） | 版付き書き込み、Journal、TOCTOU の dirfd 経路 |
| HMAC 署名、時刻窓、nonce、ROOT 封じ込め | bwrap、`.git` 拒否、実行制限、鍵のローテーション |
| env 25 メソッドのうち 20 個 | `openDirReader` / `watch` / `createTemp*` は型付きエラー |
| 計測（RPC 数・RTT・bytes） | DO の CPU / メモリ、eviction 後の再開、コスト実測 |

## 分かったこと

1. **上流が想定済みだった。** 1.5.0 に DO 用の storage アダプタ、`Harness.wake()` / `onWake`、
   `ShellExecOptions.window`（遅い回線向けの出力間引き）が入っている。「借りる」の範囲で収まる。
2. **ツールが使う ExecutionEnv は 25 メソッド中 10 個。** read / write / bash / edit が触るのは
   `absolutePath` `joinPath` `canonicalPath` `readTextFile` `openBinaryReader` `writeFile`
   `exists` `fileInfo` `exec` `id`。リモート実装のコストはここで決まる。
3. **実デプロイで 1 op 28ms（p95 61ms）。** 1 ターン 4 op で 181ms。モデルの時間に比べれば小さい。
   ローカル workerd + トンネル（231ms）より速く、DO が colo 内でエッジに着く効果が見えた。
4. **上流のツールは「1 呼び出し = 1〜2 RPC」に収まる。** read が内部で stat を 1 回足すだけ。
5. **`cf` は wrangler 設定を取り込める。** `cf migrate wrangler.toml` が `cloudflare.config.ts` を作る。
   DO の binding と migrations だけ手直し（`exports.durableObject({ storage: "sqlite" })`）。

計測値は [RESULTS.md](RESULTS.md)。
