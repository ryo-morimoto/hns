# 永続化と並行の観点

状態やファイルを書く、再送される、同時に走る、上限を持つ変更で読む。根拠は [design.md](../design.md)。

| 観点 | 条件 | 確認 | Ref |
| --- | --- | --- | --- |
| 冪等・再送の同一性 | 同じ操作が2回届く。キーを誰が決めるか、記録をいつまで持つかが未定 | 同キー別内容は `denied`（記録済み outcome を返して黙って捨てない）。同内容は二重適用しない。失敗も outcome か（[workspace.md](../workspace.md)） | [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558), [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) |
| 資源の上限が無い | 追記する配列・ログ・journal に削除が無い。戻り値が全量 | 上限があり超えたら落ちるか（無いなら docs に「無い」）。単位は byte（JSON 化後）。設定値に 0・負・超過（[limits.md](../limits.md)） | [API Design](https://www.infoq.com/articles/API-Design-Joshua-Bloch/), [Leaky Abstractions](https://www.joelonsoftware.com/2002/11/11/the-law-of-leaky-abstractions/), [AIP-158](https://google.aip.dev/158) |
| 移行で壊れる | 保存形式が変わる（列の追加・削除、backfill、user_version、破壊的 ALTER） | 古い DB を開いて移行できるか。戻せるか。途中で落ちたときの状態 | [Hyrum's Law](https://www.hyrumslaw.com/), [AIP-158](https://google.aip.dev/158) |
| 書き込みが消える・壊れる | 丸ごと置き換える。保存・更新が同時に走る。docs が原子性・復旧を謳う | 同版へ2本 → 片方 applied・片方 conflict（[workspace.md](../workspace.md) T-03）。journal・temp・audit は2本残るか。途中で落として再オープンできるか | [Design by Contract](https://www.informit.com/store/object-oriented-software-construction-9780136291558), [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110) |
