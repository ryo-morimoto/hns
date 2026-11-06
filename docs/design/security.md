# 設計: セキュリティ

認可・秘密・sandbox に触れる設計をするときに読む。索引は [design.md](../design.md)。

## 入力を境界で検査する

- **条件**: 外部の文字列がパス・temp 名・コマンド・URL・SQL の一部になる
- **命令**: 正規化し、許可リストで絞る。パスは内部生成に置き換えられないか先に考える
- **補足**: モデルやクライアントが決めた文字列を、そのままパスやコマンドに使わない
- **Ref**: [Parse, Don't Validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) / [OWASP API Security](https://owasp.org/API-Security/)

## 秘密をログ・イベント・エラーに出さない

- **条件**: エラー・イベント・テスト fixture・例外メッセージを作る
- **命令**: 残すのはパスと状態だけ。token・key・body・header を残さない
- **補足**: デバッグ用の dump が最も漏れる。fixture も repo に入る
- **Ref**: [OWASP API Security](https://owasp.org/API-Security/) / [PAGNI（セキュリティ）](https://jacobian.org/2021/jul/8/appsec-pagnis/)

## 既定を安全側にする

- **条件**: オプションや既定値で、守りが弱くなる側が既定になる
- **命令**: 危険側を既定にしない。無効化は明示的な設定にする
- **補足**: 呼び出し元が無い安全機構は、配線するか「不活性」と docs に書く
- **Ref**: [Fail Fast](https://martinfowler.com/ieeeSoftware/failFast.pdf) / [API Design](https://www.infoq.com/articles/API-Design-Joshua-Bloch/) / [PAGNI (security)](https://jacobian.org/2021/jul/8/appsec-pagnis/)

## 検証できないなら提供しない

- **条件**: sandbox・認証・root の同一性を確認できない
- **命令**: 機能を出さず、拒否する（fail closed）
- **補足**: できない検査を「たぶん大丈夫」で通さない
- **Ref**: [Fail Fast](https://martinfowler.com/ieeeSoftware/failFast.pdf) / [OWASP API Security](https://owasp.org/API-Security/)

## 取り返せないセキュリティは先に備える

- **条件**: 監査・暗号化・認証・保存期間を後回しにしようとしている
- **命令**: 最初に入れる。後から履歴は復元できない
- **補足**: ただし機密を無条件に保存しない。何を残すかは別の判断
- **Ref**: [PAGNI (security)](https://jacobian.org/2021/jul/8/appsec-pagnis/) / [PAGNIs](https://simonwillison.net/2021/Jul/1/pagnis/)
