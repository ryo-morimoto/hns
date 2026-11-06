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
## D003: MVP は 1マシンで「会話→編集→差分→再開」
date: 2026-11-06 · by: user · issue: -

最初の実用範囲は 1 マシン。セルフホスト起動、会話、権限つきファイル編集、差分、再開までを通し、
2マシン接続は M3 に送る。要件#2 の配置（A/B）は [topology.md](topology.md) で比較中。
## D004: マシン側は A（中央 + pi-env/SSH）で開始する
date: 2026-11-06 · by: user · issue: -

責務を10に分けた結果、MVP で効くのは接続・認証・セットアップ・資格情報の4つだけで、どれも exec で足りる。
常駐サービスとポートは A では無理だが MVP の対象外（[分解](topology.md)）。
前提: 対象マシンへ到達できる / git・gh・tooling は既に設定済み / sudo と対話は人手。
A'（常駐 Agent）に上げる条件は、マシン初期化・資格情報管理・常駐サービスを製品機能にするとき。
## D005: Agent の Tool は Workspace と sandbox を経由する
date: 2026-11-06 · by: user · issue: 0007

組み込みの `read`/`write` は使わず、`read_file`/`write_file` を自前で登録して Workspace の版チェックを通す。
`bash` は `createBashTool` を sandbox（`createSandboxEnv`）越しに動かす。
組み込み Tool は `api.env` を直接触るため、条件付き保存も root 封じ込めも通らない。
## D006: 次は Editor、Provider は鍵が来てから
date: 2026-11-06 · by: user · issue: 0008

MVP の受入は「会話→編集→差分→再開」。会話は faux で通ったので、次は人間側の編集を成立させる。
実 Provider（U-05）は API 鍵がこの環境に無く、検証できないため後回しにする。
Editor は Workspace の競合契約を人間の操作で確かめる場でもある。
