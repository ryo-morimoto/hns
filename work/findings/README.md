# Review findings

レビューで出た指摘を、1行1件で追記する場所。issue は「作業」、findings は「再発の観測」を持つ。

- `findings.jsonl` は **追記のみ**。既存行を書き換えない。訂正は新しい entry の `supersedes` で表す。
- `at` は発生日（分かるならタイムゾーン付き ISO 8601）。`recorded_at` は記録日。
- `location` は `path[:line]`。`summary` は1行、`observation` は実際に見たこと、`fix` は直し方。
- `mechanism` は `type` / `codec` / `lint` / `test` / `doc` / `none`。blocking の指摘は mechanism を1つ必須にする。
- 同じ原因が再発したら `recurrence_of` に元の id を入れる。件数ではなく再発を見る。
- まだ直していないものは `status: "open"` と issue 番号を残す。

## フィールド

```json
{
  "id": "F-0001",
  "at": "2026-11-07T05:30:00+09:00",
  "recorded_at": "2026-11-07T05:40:00+09:00",
  "issue": "0047",
  "source": "review",
  "reviewer": "store-review",
  "severity": "medium",
  "blocking": true,
  "location": "packages/store/src/migrate.ts",
  "summary": "migration silently skipped a newer user_version",
  "observation": "what actually happened, with the command/result",
  "fix": "the smallest correction",
  "mechanism": "type",
  "mechanism_ref": "packages/core/src/codecs.ts",
  "status": "fixed",
  "recurrence_of": null,
  "commit": "9eedd17",
  "supersedes": null
}
```

## 集計

`jq` があれば:

```bash
jq -r '.mechanism' work/findings/findings.jsonl | sort | uniq -c
jq -r 'select(.blocking) | .summary' work/findings/findings.jsonl
jq -r 'select(.recurrence_of != null) | .id + " <- " + .recurrence_of' work/findings/findings.jsonl
```

## 範囲

2026-11-07 の 0045・0047・0066 の review を初期データとして持つ（25件）。0052〜0065 の詳細は各 issue を正とし、ここには重複して書かない。
今後の review は、verdict を出すたびにこのファイルへ追記する。
