# 0001: Pi Durable 1.5.0 を固定し、ExecutionEnv を境界にする

- 状態: **採用（暫定）** / 2026-11-06 / ユーザー承認待ち
- 関連: [実測](../research/pi-durable-1.5.0.md)

## 決定

- `pi-durable` / `pi-env` / `pi-ai` を **1.5.0 exact pin**。
- ファイルの安全（`expectedVersion` / Journal / 認可 / イベント）は **Workspace 層**が持つ。
- Durable の内部 Storage・クラスには結合しない。Tool は `api.env` 越しに使う。

## 理由

ExecutionEnv に条件付き書き込みが無く、組み込みツールの直列化もプロセス内限定だった。
Agent Loop と永続化は借り、**プロダクト固有の差分だけ自作**する（要件v0.3 の Build vs Buy）。

## 選択肢

A: 自前層（採用） / B: Durable をフォークして CAS を足す / C: Agent Runtime ごと自作

## 結果

- 利点: 上流追従、配置の差し替え（遠隔化）が可能。
- 制約: 安全責務が2層になる。上流 API 変更に追随が必要。組み込み `write`/`edit` は条件付き保存を満たさない。

## 見直し

上流が CAS を提供した / 1.6 以降で破壊的変更 / Workspace 層のコストが無視できない / 要件#2 の解釈が確定した。
