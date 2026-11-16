# E2E のブラウザ行列（Firefox / mobile Firefox）調査

2026-11-17 / lead / 0043

## 問い

0043 の E2E とテスト要件に Firefox（desktop）と mobile Firefox を追加するとき、どのブラウザ・端末を、どの層で、どの頻度で回すのが妥当か。既製品のテスト設計と他の OSS の設計を参照して決める。

## 結論

- **3 構成**にする。**chromium**（Desktop Chrome）、**firefox**（Desktop Firefox）、**firefox-mobile**（Firefox + mobile viewport）。
- **PR はスモークだけ、nightly は全部**を 3 構成で回す。全ジャーニー × 全ブラウザを PR で回さない。
- 認証は Playwright 1.61+ の **context.credentials** を全ブラウザで使う。PRF だけは CDP の Chromium に残し、PR は Chromium の 1 回だけ、nightly も Chromium のみにする。
- mobile Firefox は **Firefox + viewport / isMobile / hasTouch** の emulation。実機の Firefox Android ではない。実機確認の置き場は未確定（0113 / 0114 のどちらか。現時点では未検証）。
- Safari / WebKit / 実機 iOS・Android / pixel diff は E2E の対象外。NFR の対応ブラウザと E2E の行列は別。

## 調査したもの

### 業界のテスト設計

| 出所 | 要点 | hns への示唆 |
| --- | --- | --- |
| [Google Testing Blog: Just Say No to More End-to-End Tests](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html) | 70/20/10（unit / integration / E2E）。E2E は遅く flaky で、失敗箇所の特定が難しい | E2E は主要ジャーニーだけ。ブラウザ差も E2E で見て、unit / component をブラウザごとに増やさない |
| [Martin Fowler: The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) | UI / E2E は少数。契約・integration で多くを証明する | ブラウザ行列はスモーク中心。ロジックは下の層に残す |
| [MDN: Strategies for carrying out testing](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Testing/Testing_strategies) | すべての組合せは試せない。A/B/C の graded support で重要度を分ける。A-grade には Firefox Android も含む | Firefox desktop と mobile Firefox を A-grade の代表にする。Safari / 実機は手動に残す |
| [GOV.UK Frontend: Browser support](https://frontend.design-system.service.gov.uk/browser-support/) | Grade A は Chrome / Firefox / Edge / Samsung Internet / Safari。A/B は自動テストの標準対象 | Firefox を自動テストの標準に入れる。Safari は E2E の代替ではなく手動確認 |
| [GitHub: Supported browsers](https://docs.github.com/en/get-started/using-github/supported-browsers) | Chrome / Edge / Firefox / Safari の最新と Firefox ESR を推奨 | 対応ブラウザと E2E の行列は別。E2E はリスクの高い組合せのサンプル |
| [Figma: System requirements](https://help.figma.com/hc/en-us/articles/360039827194-What-are-the-system-requirements-for-Figma) | Chrome / Firefox / Safari / Edge の最低版を明示 | NFR の対応ブラウザを明示し、E2E の範囲と混同しない |
| [BrowserStack: Emulators vs real devices](https://www.browserstack.com/guide/testing-on-emulators-simulators-real-devices-comparison) / [Sauce Labs](https://saucelabs.com/resources/blog/mobile-device-emulator-and-simulator-vs-real-device) | エミュレータは実機の代替ではない | mobile Firefox は viewport emulation。実機は手動（置き場は未確定） |
| [Gradle: How We Handle Flaky Tests](https://blog.gradle.org/how-we-handle-flaky-tests-in-gradle) | retry 1 で flake の約 90% を吸収。quarantine は nightly に移し、根本原因を直す | retry 1、trace on-first-retry、quarantine は nightly。flake を retry で隠さない |
| [GitLab: Test Quarantine Process](https://handbook.gitlab.com/handbook/engineering/testing/quarantine-process/) | quarantine は一時的。owner が fix / delete / lower-level を選び、期限付きで戻す | file + project + tag + owner + 14 日 SLA（D099 / D101）。smoke は quarantine しない |
| [Google: Flaky Tests at Google](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html) | 約 1.5% の実行が flaky。pass→fail の約 84% が flaky 由来 | flake を計測し、nightly の failOnFlakyTests で検出する |

### OSS の Playwright 設定

| 出所 | 観察 | hns への示唆 |
| --- | --- | --- |
| [Cal.com](https://github.com/calcom/cal.com/blob/main/playwright.config.ts) | Firefox / WebKit / mobile は embed-core だけ。全テストには広げていない | 全ジャーニー × 全ブラウザを PR で回さない。スモークだけ広げる |
| [Element Call](https://github.com/element-hq/element-call/blob/main/playwright.config.ts) | Chromium + Firefox + mobile Chrome。Safari は理由付きで不参加。Firefox の prefs を用途別に設定 | Firefox は必要最小の prefs。Safari / WebKit は E2E の対象外 |
| [Storybook](https://github.com/storybookjs/storybook/blob/next/code/playwright.config.ts) | Firefox / WebKit / mobile の project はコメントアウト。実運用は Chromium 中心 | project を定義しても、PR の範囲は別に決める |
| [Next.js の Playwright 例](https://github.com/vercel/next.js/blob/canary/examples/with-playwright/playwright.config.ts) | Desktop Chrome + Mobile Chrome + Mobile Safari。Desktop Firefox はコメントアウト | mobile は device descriptor、desktop は browser 名で分ける。Firefox mobile は descriptor が無いので自作する |
| [Nuxt](https://github.com/nuxt/nuxt/blob/main/playwright.config.ts) | Chrome のみ。builder / dev / built の matrix で分ける | browser 以外の軸も project にできる。hns は browser × form factor を軸にする |
| [Grafana](https://github.com/grafana/grafana/blob/main/playwright.config.ts) | 機能・ロールごとの project、auth setup + storageState、CI workers=4 | auth setup と project 分割の型を借りる。hns は workers=1 + shard |
| [Astro](https://github.com/withastro/astro/blob/main/packages/astro/playwright.config.js) | Chrome Stable のみ。CI workers=1、retries 2、forbidOnly | CI の workers=1 / forbidOnly / globalTimeout を採用 |

### Playwright の一次資料

- [Projects](https://playwright.dev/docs/test-projects): project は browser / device / 環境の構成単位。setup project を dependencies にでき、--project で絞れる。--no-deps で依存を外せる。
- [Authentication](https://playwright.dev/docs/auth): storageState は cookies / localStorage / IndexedDB / passkey を運べる。共有アカウントは「サーバ側状態を変更しないテスト」向き。サーバ側状態を変えるならユーザーを分ける。
- [Browsers](https://playwright.dev/docs/browsers): Playwright の version が browser の version を固定する。npx playwright install で入れる。
- [CI](https://playwright.dev/docs/ci): workers=1 を推奨。globalTimeout を必ず設定。npx playwright install --with-deps で browser を入れる。
- [Sharding](https://playwright.dev/docs/test-sharding): --shard と blob + merge-reports。fullyParallel で test 単位に分ける。
- [Best Practices](https://playwright.dev/docs/best-practices): user-visible behavior、テストの分離、third-party をテストしない、web-first assertion、sleep 禁止。
- [Credentials](https://playwright.dev/docs/api/class-credentials): Playwright 1.61+ の context.credentials は仮想 WebAuthn 認証器。create / get / delete / install を持つ。storageState({ credentials: true }) は 1.62+。
- [PR #40849](https://github.com/microsoft/playwright/pull/40849): Credentials は Chromium / Firefox / WebKit で動く。init script + binding の browser 非依存実装。
- [issue #43921](https://github.com/microsoft/playwright/issues/43921): Credentials は hasPrf / hasLargeBlob などの高度なオプションを公開していない。PRF は CDP の WebAuthn.addVirtualAuthenticator に残る。
- [PR #41179](https://github.com/microsoft/playwright/pull/41179): Firefox の isMobile は 1.61.0 でサポートされた。
- [deviceDescriptorsSource.json](https://github.com/microsoft/playwright/blob/main/packages/isomorphic/deviceDescriptorsSource.json): Firefox の device は Desktop Firefox / Desktop Firefox HiDPI だけ。mobile Firefox の descriptor は無い。

## わかったこと

### 1. ブラウザ行列はリスクベースにする

MDN は「すべての組合せは試せないので、重要なものに絞る」とし、A/B/C の graded support を勧める。A-grade には Chrome / Firefox / Safari / Edge の desktop と、iOS Safari / Firefox Android などの mobile が入る。Google は 70/20/10 を最初の目安にし、E2E を増やしすぎない。Fowler も UI / E2E は少数で、下の層で多くを証明する。

OSS の実例も同じ方向だった。Cal.com は Firefox / WebKit / mobile を embed-core だけに限定し、Storybook と Next.js の例は Firefox をコメントアウトし、Element Call は Chromium + Firefox + mobile Chrome で Safari を外している。全テスト × 全ブラウザを PR で回す例は少ない。

したがって hns は、**PR はスモーク 3 本 × 3 構成、nightly は全ジャーニー × 3 構成**にする。Phase 2 でジャーニーが増えても、PR は @smoke だけに絞る。

### 2. 対応ブラウザと E2E の行列は別

GitHub は Chrome / Edge / Firefox / Safari の最新と Firefox ESR を推奨し、Figma は Chrome / Firefox / Safari / Edge の最低版を明示する。GOV.UK は Grade A/B/C/X を分け、A/B は自動テストの標準対象にする。MDN は A-grade に Firefox Android を入れ、解析の偏り（Firefox Mobile の利用者がいないから不要、ではなく、壊れているから利用者がいない可能性）も警告する。

hns の NFR は Chrome / Safari / Firefox / iOS Safari を対象にする。E2E で全部を回すのではなく、**Firefox desktop と mobile Firefox を A-grade の代表として自動化**し、Safari / iOS Safari / 実機 Android は手動確認に残す。置き場は未確定（0113 / 0114 のどちらか）で、現時点では未検証。Playwright WebKit は Safari ではないので、Safari の代わりと呼ばない。

### 3. Playwright の project / auth / CI

Playwright の project は browser / device / 環境の構成単位で、setup project を dependencies にできる。auth は storageState を使えるが、共有アカウントはサーバ側状態を変更しないテスト向き。hns はテストごとに user / workspace を作るので、共有 storageState を既定にしない。

CI は workers=1 を推奨し、globalTimeout を必ず設定する。並列化は shard で行い、blob + junit を merge する。trace は on-first-retry、video は off、retry は診断用に限る。これは D099 の方針と一致する。

### 4. 認証は cross-browser Credentials、PRF だけ CDP

Playwright 1.61+ の context.credentials は Chromium / Firefox / WebKit で動く。init script + binding の browser 非依存実装で、CDP は不要。これにより Firefox / mobile Firefox でも passkey の登録・ログインを E2E で回せる。

ただし Credentials は hasPrf などの高度なオプションを公開していない。PRF は CDP の WebAuthn.addVirtualAuthenticator に残る。hns の PRF は DEK の unlock に使うので、**PRF のテストだけ Chromium の CDP** に残し、PRF なしのログイン（セッション成立 + locked）は Firefox / mobile Firefox の PR と Chromium の nightly で回す。

PoC の run-passkey.mjs は PRF なしで「登録はできるが unlocked=false」を確認し、run-prf.mjs は hasPrf=true で unlock / secret read/write / 再起動後の lock / 復旧コードの unlock を確認している。この 2 経路を E2E に移す。

### 5. mobile Firefox は viewport emulation

Playwright の device 一覧にある Firefox は Desktop Firefox / Desktop Firefox HiDPI だけ。mobile Firefox の descriptor は無い。Firefox の isMobile は 1.61.0 でサポートされ、RDM の mobile mode（viewport media query / touch / pointer）として動く。

したがって firefox-mobile は、devices['Desktop Firefox'] に viewport 390×844、screen 390×844、deviceScaleFactor 3、isMobile: true、hasTouch: true を重ねて作る。UA は Desktop Firefox のままにし、UA 分岐ではなく CSS の responsive で mobile を成立させる。

これは実機の Firefox Android ではない。safe area / 仮想キーボード / UA は再現しないので、実機確認の置き場は未確定（0113 / 0114 のどちらか。現時点では未検証）。BrowserStack / Sauce Labs も、エミュレータは実機の代替ではないとしている。

### 6. flake は retry で隠さない

Gradle は retry 1 で flake の約 90% を吸収しつつ、too-flaky なテストは nightly の quarantine に移して根本原因を直す。GitLab は quarantine を一時的なものとし、owner が fix / delete / lower-level を選び、期限付きで戻す。Google は約 1.5% の実行が flaky で、pass→fail の約 84% が flaky 由来と報告している。

hns は D099 の retry 1 / trace on-first-retry / video off / quarantine file + project + tag + owner + 14 日 SLA を維持する。smoke は quarantine しない。nightly は failOnFlakyTests で検出する。D101 は D099 の PR 60 秒 / nightly 8 分を 90 秒 / 12 分に置き換える。

## hns への適用

### ブラウザ / 端末

| project | engine | 設定 | PR | nightly |
| --- | --- | --- | --- | --- |
| chromium | Chromium | Desktop Chrome（1280×720） | 全スモーク | 全ジャーニー |
| firefox | Firefox | Desktop Firefox（1280×720） | 全スモーク | 全ジャーニー |
| firefox-mobile | Firefox | 390×844 / DPR 3 / isMobile / hasTouch | 全スモーク | 全ジャーニー |

### 認証

- 全ブラウザ: context.credentials で passkey 登録・ログイン。PRF なしは Firefox / mobile Firefox の PR と Chromium の nightly で、セッション成立 + locked を確認する。
- Chromium: PRF ありを CDP の WebAuthn.addVirtualAuthenticator で確認する。@chromium-cdp でタグし、chromium project だけに残す。
- テストごとの一意ユーザー: fixture が context.credentials.create(rpId) で仮想 credential を作り、公開鍵だけをテスト専用 Worker の /__e2e/seed に登録する。秘密鍵はテストプロセスから出さない。
- 共有 storageState は既定にしない。将来 setup project を導入するときの選択肢として残す。

### 範囲

- PR: スモーク 3 本 × 3 構成（Phase 2 でも @smoke だけ）。Chromium は PRF、Firefox 系は PRF なし。
- nightly: 全ジャーニー × 3 構成を shard 2→4。
- PR p50 < 90 秒、nightly < 12 分は暫定。Phase 1 の実測を 0043 に残す。
- Safari / WebKit / 実機 iOS・Android / pixel diff は対象外。

## 未確認・残リスク

- Playwright 1.61+ の Credentials が、hns のログイン画面（PRF extension を要求する経路）で期待どおり「PRF なし」として扱われるか。PoC の run-passkey.mjs は同等の経路を確認しているが、0043 の実装で再確認する。
- Firefox の RDM が、hns の mobile レイアウト（safe area / 仮想キーボード / hover なし）をどこまで再現できるか。実機確認の置き場は未確定（0113 / 0114 のどちらか。現時点では未検証）。
- cf dev + Vite の Firefox 接続（HTTP/2 / WebSocket）で flakes が出ないか。Element Call は Firefox の HTTP/2 問題を prefs で回避している。hns は必要になったときだけ prefs を足す。
- PR 9 実行が p50 90 秒に収まるか。超えたら PR の Firefox / mobile Firefox を 1 本ずつに減らすか、mobile Firefox を nightly に移す。
- Firefox の flake 率。nightly の failOnFlakyTests と quarantine で観測する。

## 参考

- Google Testing Blog: [Just Say No to More End-to-End Tests](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html), [Flaky Tests at Google](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)
- Martin Fowler: [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)
- MDN: [Strategies for carrying out testing](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Testing/Testing_strategies)
- GOV.UK: [Browser support](https://frontend.design-system.service.gov.uk/browser-support/)
- GitHub: [Supported browsers](https://docs.github.com/en/get-started/using-github/supported-browsers)
- Figma: [System requirements](https://help.figma.com/hc/en-us/articles/360039827194-What-are-the-system-requirements-for-Figma)
- BrowserStack: [Emulators vs real devices](https://www.browserstack.com/guide/testing-on-emulators-simulators-real-devices-comparison)
- Sauce Labs: [Emulator vs simulator vs real devices](https://saucelabs.com/resources/blog/mobile-device-emulator-and-simulator-vs-real-device)
- Gradle: [How We Handle Flaky Tests](https://blog.gradle.org/how-we-handle-flaky-tests-in-gradle)
- GitLab: [Test Quarantine Process](https://handbook.gitlab.com/handbook/engineering/testing/quarantine-process/)
- Playwright: [Projects](https://playwright.dev/docs/test-projects), [Authentication](https://playwright.dev/docs/auth), [Browsers](https://playwright.dev/docs/browsers), [CI](https://playwright.dev/docs/ci), [Sharding](https://playwright.dev/docs/test-sharding), [Best Practices](https://playwright.dev/docs/best-practices), [Credentials](https://playwright.dev/docs/api/class-credentials)
- Playwright PRs / issues: [#40849](https://github.com/microsoft/playwright/pull/40849), [#43921](https://github.com/microsoft/playwright/issues/43921), [#41179](https://github.com/microsoft/playwright/pull/41179)
- OSS configs: [Cal.com](https://github.com/calcom/cal.com/blob/main/playwright.config.ts), [Element Call](https://github.com/element-hq/element-call/blob/main/playwright.config.ts), [Storybook](https://github.com/storybookjs/storybook/blob/next/code/playwright.config.ts), [Next.js example](https://github.com/vercel/next.js/blob/canary/examples/with-playwright/playwright.config.ts), [Nuxt](https://github.com/nuxt/nuxt/blob/main/playwright.config.ts), [Grafana](https://github.com/grafana/grafana/blob/main/playwright.config.ts), [Astro](https://github.com/withastro/astro/blob/main/packages/astro/playwright.config.js)
