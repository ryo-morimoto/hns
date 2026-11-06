# 0053: operationId の検証位置を決める

status: done
depends-on: 0045
touches: packages/workspace, packages/core

## Goal

operationId を検証しているのは HTTP の境界（core の `OperationIdSchema`）だけ。workspace.write を
直接使う経路（agent の write_file ツールなど）では素通しになっている。規則は1つに保ったまま、
workspace の入口でも弾くかどうかを決め、決めた方針を実装する。

## Acceptance criteria

- [x] `Workspace.write` の入口で core の `OperationIdSchema` を parse する（regex を複製しない）
- [x] 不正な id は `Denied` で拒否し、0045 の回帰テストを「拒否」に戻す
- [x] Vitest の `source` 条件と、build 後の dist の両方で解決できることを確認する
- [x] workspace に同種の regex を置かない（二重定義をしない）ことをレビューで確認する

## Notes

- 0045 で temp 名を内部生成にしたため、**安全上は必須ではない**（operationId は journal のキーにしかならない）。
  これは API 契約を明確にするための判断。不要なら close して Result に理由を書く。
- 0035 の HTTP 入口は core の schema を使う。workspace の検証はその再利用であり、二重定義ではない。
- packages/workspace を触るので 0054 / 0055 と直列。

## やらないこと

- `OperationId` の brand 型導入（取り違えが実際に起きてから）。
- agent ツール側だけの独自検証（規則を増やす）。

## Log

- 2026-11-07: 作成（0045 の見直しで「HTTP だけ」と分かったため）。

- 2026-11-07: レビュー指摘への対応で、workspace は「同じ operationId を別の内容で使う」ことを `Denied` にし、
  agent の `write_file` はモデルから `operationId` を受け取らず `tool:<callId>` を内部生成するようにした。
  形式の検証（`OperationIdSchema` の parse）は本 issue のまま残す。
- 2026-11-07: agent が作る id を wire の書式（`[A-Za-z0-9_-]{1,64}`）に合わせた（`call-` + 整えた callId）。
  workspace の入口で `OperationIdSchema` を parse しても agent の経路が壊れない状態になった。
- 2026-11-07: 0066 / 0068 の実装で受入条件を満たしたため close（追加実装なし）。確認は Result。
## Result

- 追加実装なしで close。0066 が workspace.write の入口で core の `operationId()`（`OperationIdSchema`）を parse し、
  不正なら `Denied` にした（workspace.ts:448-461）。0068 で拒否を audit に残すところまで揃えた。
- workspace に同じ regex は無い。`packages/workspace/src` と `packages/core/src/schemas.ts` を
  `A-Za-z0-9_-` / `v.isoTimestamp` で走査して 0 件（owner テストも同条件で走る）。
- 回帰テスト: `hardening.test.ts` の "an invalid operationId is refused before writing" が `../../escape` を
  `Denied` にし、journal の ops と temp を作らないことまで見る（0045 の「素通し」への逆戻りを捕まえる）。
- source / dist の両解決: `npm test -w @hns/workspace`（Vitest の `source` 条件で src を解決、66 passed）と、
  `npm run build -w @hns/core -w @hns/workspace` 後の `import("@hns/workspace")`（dist を解決、`Workspace` が function）を確認。
- 方針は「workspace の入口でも parse する」を採用。0035 の HTTP 入口と同じ規則の再利用で、二重定義ではない。
- 0053 の「やらないこと」にあった `OperationId` の brand は 0066 が先に導入した（取り違え防止の判断は 0066 側）。
- 0066 / 0068 の独立 review がこの範囲を含む（0053 自体は新規 diff なし）。
