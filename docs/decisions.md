# Decisions

追記専用の決定ログ。新しいものが下。変更は新しいエントリで置き換え、置き換えたことを書く。

## D001: Pi Durable 1.5.0 を固定し、ExecutionEnv を境界にする
date: 2026-11-06 · by: coordinator · issue: -

`pi-durable` / `pi-env` / `pi-ai` を **1.5.0 exact pin**。Agent の実行と永続化は借り、
ファイルの安全（`expectedVersion` / Journal / 認可 / イベント）は Workspace 層が持つ。
ExecutionEnv に条件付き書き込みが無く、組み込みツールの直列化もプロセス内限定だったため
（[実測](../work/research/pi-durable-1.5.0.md)）。Durable の内部 Storage・クラスには結合せず、
組み込みの `write`/`edit` は本番の Agent に使わせない。

代替案: Durable をフォークして CAS を足す / Agent Runtime ごと自作。どちらも上流追従か
再実装コストの面で不利。上流が CAS を提供したら、この層を薄くする。

## D002: リポジトリ構成（README / ARCH / docs / work）
date: 2026-11-06 · by: coordinator · issue: -

README は「やりたいこと」、ARCH はアーキテクチャ、docs はコンポーネント・レイヤー別の仕様、
work は作業（BOARD・issues）と調査・PoC（research・poc）。docs はネストさせずフラットに置く。
提供資料の原文は work/research に置き、書き換えない。
