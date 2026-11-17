# ツール呼び出しの capability 契約

2026-11-17 / D091。調査は [work/research/tool-call-fastpath-security.md](../work/research/tool-call-fastpath-security.md)。決定の一覧は [decisions.md](decisions.md) の D090 / D091。

hns のツール呼び出しに、**R1 定義の不変性 / R2 呼び出しの同一性 / R3 権限の不変性 / R4 監査の不変性**を入れる。Phase 0 で呼び出しの同一性と監査、Phase 1 で capability grant とローカル判定を実装する。egress・資格情報・middleware は Phase 2 以降で、この契約には入れない（D090）。

## 1. 範囲と非目標

**入れる**:

- ツールマニフェスト（名前・版・引数の形・危険度）のハッシュ固定と、呼び出しごとの再照合。
- 正規化 JSON（JCS）による `argsHash` / `callHash`。判定した呼び出しと実行する呼び出しを同一にする。
- 期限・範囲・回数を持つ署名付き capability grant と、マシン側のローカル判定。
- ポリシー改訂・提案・review token・人承認・CAS。
- 追記専用の監査イベントとハッシュ連鎖。

**入れない**:

- seccomp user notification、TLS MITM、Z3、Kubernetes / マルチ runtime、middleware による呼び出し書き換え（D090）。
- bash のコマンド文字列の意味解析。bash は「封筒（network / fs / workdir）」で制御し、危険な 1 回は exact 承認で縛る。
- 自動承認。Phase 1 はすべて人承認とする。
- glob。Phase 1 のパスは前方一致だけで、`*` を含むポリシーは `unsupported` として拒否する。

## 2. モジュール境界

| 場所 | 持つもの | 持たないもの |
| --- | --- | --- |
| `@hns/core` の `./capability` | 型・valibot schema・JCS・ハッシュ・grant 検証・能力集合の代数・denial code・review token | 鍵の保存、HTTP、DB、ポリシーの保存 |
| `@hns/agent` | ツールマニフェストの生成、`ToolRuntime` の呼び出し、grant のキャッシュ、監査イベントの発火 | ポリシーの保存、grant の署名 |
| `@hns/server` | ポリシー改訂・提案・承認、grant の発行と署名、Session DO の監査 | ツールの実行、マシンの状態 |
| `@hns/machine` | grant の検証、ローカル判定、回数カウンタ、実行 | ポリシーの保存、grant の発行 |
| `@hns/workspace` | ファイルの版・sandbox・bwrap | ツール権限の判定 |
| `@hns/store` | D1 の行と migration、Row → 公開型 | ポリシーの意味論、grant の検証 |
| `@hns/web` | 承認画面 | ポリシーの意味論 |

依存は `server → agent / store / workspace → core`、`machine → workspace → core` のまま。`@hns/core/capability` は web から import しない（ブラウザ bundle に crypto を入れない）。

## 3. 型（公開契約）

`@hns/core/capability` が export する型。実装は 0220。

```ts
export const TOOL_IDS = ["read_file", "write_file", "bash"] as const;
export type ToolId = (typeof TOOL_IDS)[number];
export type ToolRisk = "read" | "write" | "exec";

export interface ToolManifest {
  readonly v: 1;
  readonly toolId: ToolId;
  readonly version: string;          // 振る舞いを変えたら上げる
  readonly descriptionHash: string;  // SHA-256(JCS(description))
  readonly parametersHash: string;   // SHA-256(JCS(parameter descriptor))
  readonly risk: ToolRisk;
  readonly outputLimits: { readonly maxBytes: number; readonly maxLines: number };
}

export interface ToolCall {
  readonly v: 1;
  readonly callId: string;           // pi-durable の "tool:<ms>:<id>"
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly args: Record<string, unknown>; // ツールの strict schema を通した後の値
}

export interface CallDigest {
  readonly argsHash: string;         // SHA-256(JCS(args))
  readonly callHash: string;         // SHA-256(JCS({v,callId,toolId,toolVersion,argsHash}))
}

export type CapabilityScope =
  | { readonly kind: "read"; readonly roots: readonly string[] }
  | { readonly kind: "write"; readonly roots: readonly string[] }
  | { readonly kind: "exec"; readonly network: "none" | "proxy"; readonly writable: boolean }
  | { readonly kind: "exact"; readonly callHash: string };

export type GrantAlgorithm = "Ed25519" | "ECDSA-P256";

export interface GrantPayload {
  readonly v: 1;
  readonly grantId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly machineId: string;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly manifestHash: string;
  readonly scope: CapabilityScope;
  readonly issuedAt: string;         // ISO 8601
  readonly expiresAt: string;        // ISO 8601
  readonly epoch: number;            // 単調増加
  readonly maxCalls: number;
  readonly maxBytes: number;
  readonly nonce: string;
  readonly alg: GrantAlgorithm;
  readonly keyId: string;
}

export interface SignedGrant {
  readonly payload: GrantPayload;
  readonly signature: string;        // base64url。JCS(payload) への署名
}
```

ポリシーと承認:

```ts
export interface ToolPolicy {
  readonly enabled: boolean;
  readonly scope: CapabilityScope;   // このツールに許す最大の範囲
  readonly grantTtlSeconds: number;  // 30..60
  readonly maxCallsPerGrant: number;
}

export interface HostPort {
  readonly host: string;
  readonly port: number;
}

export interface PolicyDocument {
  readonly v: 1;
  readonly tools: {
    readonly read_file?: ToolPolicy;
    readonly write_file?: ToolPolicy;
    readonly bash?: ToolPolicy;
  };
  readonly egress: { readonly enabled: boolean; readonly hosts: readonly HostPort[] };
}

export interface PolicyRevision {
  readonly workspaceId: string;
  readonly revision: number;         // 1 から
  readonly hash: string;
  readonly document: PolicyDocument;
  readonly createdAt: string;
  readonly createdBy: string;
}

export type PolicyProposalStatus = "pending" | "approved" | "rejected";

export interface PolicyProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly baseRevision: number;
  readonly baseHash: string;
  readonly candidate: PolicyDocument;
  readonly candidateHash: string;
  readonly reviewToken: string;
  readonly requestedBy: string;      // principal
  readonly reason: string;
  readonly status: PolicyProposalStatus;
  readonly createdAt: string;
  readonly decidedBy?: string | undefined;
  readonly decidedAt?: string | undefined;
  readonly decisionReason?: string | undefined;
}

export type CapabilityAtom =
  | { readonly kind: "read"; readonly value: string }
  | { readonly kind: "write"; readonly value: string }
  | { readonly kind: "exec"; readonly value: "network=none" | "network=proxy" | "writable" }
  | { readonly kind: "egress"; readonly value: string }; // host:port

export type PolicyDiffKind = "equal" | "narrowing" | "expansion" | "mixed";

export interface PolicyDiff {
  readonly kind: PolicyDiffKind;
  readonly added: readonly CapabilityAtom[];
  readonly removed: readonly CapabilityAtom[];
}
```

判定と監査:

```ts
export const DENIAL_CODES = [
  "policy_denied",
  "tool_disabled",
  "scope_exceeded",
  "manifest_mismatch",
  "grant_invalid",
  "grant_expired",
  "grant_algorithm_mismatch",
  "grant_replayed",
  "counter_exhausted",
  "epoch_stale",
  "path_outside_root",
  "command_not_allowed",
  "egress_denied",
  "approval_stale",
  "unsupported",
] as const;
export type DenialCode = (typeof DENIAL_CODES)[number];

export type PolicyDecision =
  | {
      readonly outcome: "allow";
      readonly policyRevision: number;
      readonly policyHash: string;
      readonly grantId?: string | undefined;
    }
  | {
      readonly outcome: "deny";
      readonly code: DenialCode;
      readonly message: string;
      readonly policyRevision?: number | undefined;
      readonly policyHash?: string | undefined;
    };

export type AuditEvent =
  | {
      readonly event: "tool.call";
      readonly v: 1;
      readonly eventId: string;
      readonly at: string;
      readonly workspaceId: string;
      readonly sessionId: string;
      readonly callId: string;
      readonly callHash: string;
      readonly argsHash: string;
      readonly toolId: ToolId;
      readonly toolVersion: string;
      readonly manifestHash: string;
      readonly grantId?: string | undefined;
      readonly prevHash: string | null;
      readonly hash: string;
    }
  | {
      readonly event: "tool.result";
      readonly v: 1;
      readonly eventId: string;
      readonly at: string;
      readonly workspaceId: string;
      readonly sessionId: string;
      readonly callId: string;
      readonly callHash: string;
      readonly argsHash: string;
      readonly toolId: ToolId;
      readonly toolVersion: string;
      readonly manifestHash: string;
      readonly decision: PolicyDecision;
      readonly durationMs: number;
      readonly grantId?: string | undefined;
      readonly prevHash: string | null;
      readonly hash: string;
    };
```

`ToolRuntime` と `GrantSource` は `@hns/agent` の公開型。エージェントはポリシーを評価せず、runtime に渡すだけ。Phase 0 は `policy`、Phase 1 は `grant` を使う。`ToolExecutionResult` は pi-durable の既存型。

監査は UI の `onEvent` と分ける。`AuditSink` は **await する**ので、`tool.call` を書けなければ実行しない。

```ts
export type AuditSink = (event: AuditEvent) => Promise<void>;
```

```ts
export type ToolAuthorization =
  | { readonly kind: "policy"; readonly decision: PolicyDecision }
  | { readonly kind: "grant"; readonly grant: SignedGrant };

export interface ToolRuntime {
  read(input: { readonly call: ToolCall; readonly authorization: ToolAuthorization }): Promise<ToolOutcome<ReadReply>>;
  write(input: { readonly call: ToolCall; readonly authorization: ToolAuthorization }): Promise<ToolOutcome<MutationResult>>;
  exec(input: { readonly call: ToolCall; readonly authorization: ToolAuthorization }): Promise<ToolOutcome<ToolExecutionResult>>;
}

export interface ToolOutcome<T> {
  readonly reply: T;                  // モデルに返す JSON
  readonly decision: PolicyDecision;  // 監査にだけ使う
  readonly durationMs: number;
}

export interface GrantRequest {
  readonly v: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly machineId: string;
  readonly call: ToolCall;
  readonly manifest: ToolManifest;
}

export type GrantResponse =
  | { readonly ok: true; readonly grant: SignedGrant }
  | { readonly ok: false; readonly decision: PolicyDecision };

export interface GrantSource {
  issue(input: GrantRequest): Promise<GrantResponse>;
}
```

## 4. 正規化とハッシュ

- **JCS**: RFC 8785。オブジェクトのキーは UTF-16 コード単位でソート、数値は ECMAScript の最短表現、文字列は JSON エスケープ。`undefined` / `NaN` / `Infinity` / `-0` は入力にしない（valibot で弾く）。
- **argsHash** = `sha256Hex(jcs(args))`。**callHash** = `sha256Hex(jcs({v:1,callId,toolId,toolVersion,argsHash}))`。すべて小文字 hex。
- **manifestHash** = `sha256Hex(jcs(manifest))`。マニフェストはコードのハッシュではなく**契約のハッシュ**。実装の完全性は deploy（Worker / Node bundle）が持つ。
- **policyHash** = `sha256Hex(jcs(document))`。
- **reviewToken** = `sha256Hex(jcs({v:1,proposalId,baseHash,candidateHash,credentialFingerprint}))`。Phase 1 の `credentialFingerprint` は `""`。
- **パス**: POSIX 相対のみ。`\\` / NUL / 絶対パス / `..` / 空セグメントを拒否。`//` は畳む。末尾 `/` は落とす。`.` は root を表す。大文字小文字は区別する。glob は拒否。
- **前方一致**: `isUnder(path, root)` は `root === "."` なら常に真、それ以外は `path === root || path.startsWith(root + "/")`。symlink の解決は実行側（machine）が行い、解決後のパスで再確認する。
- **同一性**: 判定に使った `callHash` と、実行直前に再計算した `callHash` が一致しなければ実行しない。machine は操作フィールド（path / content / command）から `ToolCall.args` を再構成し、`callHash` を比較する。

## 5. capability grant

**発行**: Session DO が、Worker から受け取った active policy snapshot（revision / hash / document）を読み、ツールの `ToolPolicy.scope` をそのまま grant の scope にする。Session DO は D1 を読まない。snapshot は send の RPC で渡され、モデルは変更できない。grant は呼び出しごとではなく、**セッション × ツール × manifest × machine** 単位で発行し、agent が TTL の間キャッシュする。これで per-call の DO 往復を消す。

**フィールド**: `grantId` は UUID、`nonce` は UUID、`epoch` は workspace の単調カウンタ、`expiresAt` は `issuedAt + ttl`（30〜60 秒）。`maxCalls` は policy の値（既定 1,000）、`maxBytes` は出力上限。

**署名**: Phase 1 は control-plane の **Ed25519** 鍵で署名する（0148）。`keyId` は公開鍵の識別子。JCS(payload) に署名する。0224 が Workers の WebCrypto で Ed25519 の sign/verify を実測し、不可なら grant を発行せず fail closed として D091 を再判定する。契約は `ECDSA-P256` の型も持つが、Phase 1 では使わない（鍵の配布を含めて Phase 2）。検証側は `alg` と key の alg が一致しなければ拒否する。

**検証（純関数 `authorizeCall`）**: 署名 → `alg` → `expiresAt` → `epoch` → `manifestHash` / tool / version → scope → `exact` の `callHash`。カウンタは純関数の外（machine の `consume`）で消費する。結果は `PolicyDecision` か `DenialCode`。

**鍵の配布**: grant は **control-plane の鍵**で署名する（0148 の Worker→machine 署名と同じ鍵）。machine は enrollment で 0148 の `GET /api/machines/keys` から公開鍵を取得し、grant の `keyId` で選ぶ。無い・読めない・keyId 不一致は fail closed。鍵を grant 応答に同梱しない（TOFU にしない）。grant 用に別の鍵を作らない。

**失効**: `epoch` はポリシーの revision。ポリシー改訂で revision が上がり、新しい grant は新しい epoch を持つ。machine は受け取った grant で `lastEpoch` を更新し、`payload.epoch < lastEpoch` を拒否する。改訂前の grant は TTL まで有効（上限 60 秒）。期限切れは必ず拒否（fail closed）。

**カウンタ**: machine は `grantId` ごとに `calls` / `bytes` を持ち、実行前にアトミックに消費する。読めない・書けない場合は拒否。状態は `~/.config/hns/grants/` に置き、agent からは見えない。

**exact 承認**: 範囲で表せない 1 回の呼び出しは `{kind:"exact", callHash}` の grant を人承認で発行する。machine は `callHash` が一致する 1 回だけ実行する（`maxCalls=1`）。**Phase 1 では exact を発行しない**。bash は network / writable の封筒だけで、範囲外は拒否する。exact の承認フロー（GraphQL / UI）は Phase 2 に分ける。型は将来のために残す。

## 6. ポリシーと承認

**初期ポリシー**: workspace の最初の利用時に revision 1 を作る。既定は `read_file: {enabled:true, scope:{kind:"read",roots:["."]}}`、`write_file` も同様、`bash` は sandbox がある環境だけ `{enabled:true, scope:{kind:"exec",network:"none",writable:false}}`、egress は無効。作成は冪等（active が無ければ作る）。

**改訂**: `policy_revisions` は不変。active は `policy_active` の 1 行（workspace ごと）で、`UPDATE ... WHERE revision = ?` の CAS で切り替える。改訂は新しい行を足すだけで、古い行を書き換えない。

**提案**: agent は `policy_proposals` に pending を作るだけ。`baseRevision` / `baseHash` / `candidate` / `candidateHash` / `reviewToken` を持つ。提案は add/remove の両方を表せるが、filesystem / process / sandbox 設定は変更できない（ツールの有効・無効、roots、bash の可否、egress の可否だけ）。

**承認**: `actor.kind === "human"` だけ。承認時に active revision が `baseRevision` と一致し、`reviewToken` を再計算して一致することを要求する。CAS で active を切り替える。監査は CAS 成功後に D1 のイベントに書き、失敗したら 500 で再試行する（D1 と DO の厳密な同一トランザクションにはしない。重複は `event_id` で防ぐ）。不一致は `approval_stale`（409）。agent の tool token は承認 API を呼べない。

**差分**: `diffPolicy(base, candidate)` は能力 atom の集合差。`added` があれば `expansion`、`removed` だけなら `narrowing`、両方なら `mixed`。Phase 1 は人が全件承認する（自動承認はしない）。比較できない形（glob、未知の tool）は `unsupported` として拒否する。path は文字列 atom として比較し、親子（`src` と `src/a`）は別 atom として `mixed` にする（安全側。実行時の許可判定だけ `isUnder` を使う）。

## 7. denial code

| code | 意味 | 再試行 |
| --- | --- | --- |
| `policy_denied` | ポリシーが許可しない | 不可（提案） |
| `tool_disabled` | ツールが無効 | 不可 |
| `scope_exceeded` | 引数が grant の範囲外 | 不可 |
| `manifest_mismatch` | ツール / 版 / manifestHash が一致しない | 不可 |
| `grant_invalid` | 署名・形が不正 | 不可 |
| `grant_expired` | 期限切れ | 可（再取得） |
| `grant_algorithm_mismatch` | alg と鍵が不一致 | 不可 |
| `grant_replayed` | 同じ grant / nonce の再利用 | 不可 |
| `counter_exhausted` | maxCalls / maxBytes 超過 | 不可 |
| `epoch_stale` | 失効済み | 可（再取得） |
| `path_outside_root` | root 外 | 不可 |
| `command_not_allowed` | コマンドが封筒の外 | 不可 |
| `egress_denied` | egress の範囲外 | 不可 |
| `approval_stale` | 承認時の revision / token 不一致 | 可（再提案） |
| `unsupported` | 判定できない形 | 不可 |

denial は例外ではなく値で返す。モデルには `{ok:false, status, code, message}` の JSON を返し、run を落とさない。

## 8. 監査

- 書き手は **Session DO**。`policy_audit` テーブルに `tool.call` と `tool.result` を 1 行ずつ追記する。`tool.call` は実行前、`tool.result` は実行後。途中で落ちた場合は result の欠落として検出できる。
- 各イベントは `prevHash` と `hash` を持ち、`hash = sha256Hex(jcs(event から hash キーを除いたもの))`。`seq` は DO SQLite の AUTOINCREMENT。追記は 1 トランザクション。
- 生の引数・出力・秘密は入れない。`argsHash` / `callHash` / `manifestHash` / `policyHash` / `grantId` / `decision` / `durationMs` だけ。
- 書き込みに失敗したら、そのツール結果はモデルに返さない（fail closed）。監査の欠落を黙って許さない。
- 読み取りは Session DO の内部 RPC `GET /rpc/policy/audit?limit=`。UI は Phase 1 では作らない。

## 9. 保存

**D1（control data、migration 0003）**:

```sql
CREATE TABLE IF NOT EXISTS policy_revisions (
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  hash TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, revision)
);
CREATE TABLE IF NOT EXISTS policy_active (
  workspace_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  base_hash TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  review_token TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_proposals_pending
  ON policy_proposals (workspace_id, status, created_at);
```

**DO SQLite（runtime）**:

- Session DO: `policy_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, at, event, workspace_id, session_id, call_id, call_hash, args_hash, tool_id, tool_version, manifest_hash, decision_json, duration_ms, grant_id, prev_hash, hash)`。
- Session DO: `session_grants (grant_id PRIMARY KEY, workspace_id, session_id, machine_id, tool_id, tool_version, manifest_hash, scope_json, issued_at, expires_at, epoch, max_calls, max_bytes, revoked_at)`。grant の発行履歴と失効の確認に使う。ポリシーの epoch は D1 の `policy_active.revision` を写したもの。

migration は加算のみ（INV-12）。既存テーブルは変更しない。

## 10. プロトコル

- **grant 発行**: Session DO のローカル関数。Worker が send の RPC に `policy: {revision, hash, document}` を載せ、Session DO が `GrantSource` に渡す。HTTP の内部 RPC は作らない。body は valibot で parse する。
- **machine**: 既存の署名付きリクエストに `authorization: SignedGrant` と `call: ToolCall` を足す。machine は `authorizeCall` と `consume` を通してから実行し、`decision` を response に返す。Phase 0 は `authorization` なしで、DO の署名済みリクエストを信頼する。
- **agent**: `ToolRuntime` が machine への transport を持つ。`GrantSource` は Session DO のローカル issuer（0224）と policy snapshot を使う。テストでは fake。
- **GraphQL（承認面、0228）**:
  - `Mutation.proposePolicy(input: PolicyProposalInput!): ProposePolicyResult!`
  - `Mutation.decidePolicy(input: DecidePolicyInput!): DecidePolicyResult!`
  - `Query.policyRevisions(workspaceId: ID!, first: Int): PolicyRevisionListResult!`
  - `Query.policyProposals(workspaceId: ID!, status: PolicyProposalStatus): PolicyProposalListResult!`
  - `PolicyProposalInput`: `workspaceId`, `readRoots`, `writeRoots`, `bash`, `network`, `reason`。`DecidePolicyInput`: `proposalId`, `reviewToken`, `approve`, `reason`。
  - `PolicyDocument { readRoots: [String!]!, writeRoots: [String!]!, bash: Boolean!, network: Boolean! }`。Phase 1 は egress を出さないので、`CapabilityScope` / `HostPort` は GraphQL に出さない。
  - `PolicyRevision { revision: Int!, hash: String!, active: Boolean!, createdAt: String!, createdBy: String!, document: PolicyDocument! }`。
  - `PolicyProposal { id: ID!, baseRevision: Int!, reviewToken: String!, status: PolicyProposalStatus!, requestedBy: String!, reason: String!, candidate: PolicyDocument!, diff: PolicyDiff! }`。
  - `PolicyDiff { kind: PolicyDiffKind!, added: [PolicyDiffAtom!]!, removed: [PolicyDiffAtom!]! }`、`PolicyDiffAtom { atomKind: String!, value: String! }`。
  - 失敗は `PolicyFailure { code: PolicyErrorCode!, message: String! }` の専用 union。code は `policy_denied` / `approval_stale` / `unsupported` / `not_found` / `invalid_request`。既存の `QueryFailure` を広げない。

## 11. 並列化とファイル所有

| issue | 主に触る場所 | 依存 | 並列の前提 |
| --- | --- | --- | --- |
| 0220 | `packages/core/src/capability/`, `packages/core/{package.json,tsdown.config.ts}` | なし | 契約の正本。最初に 1 本 |
| 0221 | `packages/agent/src/{capability,tools,events}.ts` | 0220 | 0220 の後に並列 |
| 0222 | `packages/server/src/do/{audit,session}.ts` | 0220, 0221 | 0221 の後（`onAudit` の API を共有） |
| 0223 | `packages/store/src/{migrations,schemas,parse,repositories/policy}`, `packages/server/src/policy/` | 0220 | 0221/0222 と並列（store の 1 レーン） |
| 0224 | `packages/server/src/do/session-grants.ts`, `packages/server/src/capability/signing.ts`, deploy の secret | 0220, 0223, 0148 | 0223 / 0148 の後。deploy の 1 レーン |
| 0225 | `packages/machine/src/capability/` | 0220, 0148, 0194 | 0224 と並列（fixture で検証） |
| 0226 | `packages/agent/src/{runtime,tools,session}.ts`, `packages/workspace/src/protocol.ts`, `packages/server/src/{edge/session,do/session,do/session-rpc}.ts`, `packages/machine/src/` | 0221, 0222, 0224, 0225, 0147, 0157 | 収束点。最後 |
| 0227 | `work/research/sandbox-hardening.md`, `packages/workspace/test/integration/` | なし | いつでも並列。製品コードを変えない |
| 0228 | `packages/server/src/graphql/` | 0223, 0198 | 0198 の後 |
| 0229 | `packages/web/src/routes/policy/` | 0228, 0160 | 0228 の後 |

同じファイルを触る issue は同時に流さない。`packages/core/package.json` / `tsdown.config.ts` は 0220 が単独で所有する。`packages/agent/src/tools.ts` は L1 の 0200 と 0221 / 0226、`packages/agent/src/session.ts` は 0202 と 0221 / 0226、`packages/server/src/do/session.ts` は 0203 と 0222 / 0226、`session-rpc.ts` は 0203 と 0222 / 0226、`packages/server/src/do/state.ts` は 0203 と 0224 が共有する。同時に流さず、先に着地した側に後続が合わせる。

## 12. 検証

| 研究の ID | 契約での場所 | 合格条件 |
| --- | --- | --- |
| S4 正規化 | 0220 | RFC 8785 のベクタ、重複キー、Unicode、数値、`..`、symlink のコーパスで一致 |
| S3 grant | 0224 / 0225 | 偽造・期限・epoch・alg confusion・replay を全拒否。検証 p95 ≤ 1ms |
| S8 監査 | 0222 | 削除・改変・順序入替を検出。追記は結果を返す前 |
| S10 差分 | 0220 / 0223 | 拡大 20 件を全検出。未対応は deny |
| S11 承認 | 0223 | agent token で承認不可。review token 不一致は 409。CAS 競合は 409 |
| S1 / S2 / S7 sandbox | 0227 | Landlock / netns+proxy / seccomp の実測。製品コードは変えない |
| S5 引数制約 | 0221 / 0226 | path / command / host の制約。bash は封筒で、文字列の意味解析はしない |
| S6 helper | 0191 | 既存の helper 常駐。write <10ms は 0191 の受入 |
| S9 資格情報 | Phase 2 | 0227 の結果で別 issue。今は作らない |
| S12 trace | 0222 / 0226 | durationMs を監査に載せる。OTel の span は後続 |

## 13. 未確定

- Phase 1 は Ed25519 固定。Workers の WebCrypto で使えるかを 0224 で実測する。不可なら grant を発行せず fail closed とし、D091 を再判定する。ECDSA は契約の型だけ。
- D1 の CAS と audit の同一トランザクション。D1 は単一 SQL 文で CAS し、audit は DO なので厳密な同一トランザクションにはならない。Phase 1 は「CAS 成功後に audit、失敗したら 500 で再試行」とし、重複は `event_id` で防ぐ。
- DoS: grant の大量発行。Session DO のレート制限と `maxCalls` で抑える。
- 監査の R2 アンカー。Phase 1 は DO のみ。外部アンカーは 0222 の後続。

## 14. 参考にした仕様

| 出所 | 何を採ったか | 何を採らなかったか |
| --- | --- | --- |
| [OpenShell](https://github.com/NVIDIA/OpenShell) の policy / supervisor / sandbox | 判定を実行主体の外に置く、deny by default、静的/動的の分離、revision と fail closed | TLS MITM、seccomp-notify、K8s/マルチ runtime（D090） |
| OpenShell の MCP L7 | ヘッダー/body の一致、重複・hop-by-hop の拒否、method + tool 名の認可 | 引数はモデル化しない（hns は型付きなので引数まで縛る） |
| OpenShell の prover / advisor | review token、差分の expansion / narrowing、unsupported は承認不可 | Z3 を実行時に使う（D090） |
| Codex の linux-sandbox / exec-server | bwrap 既定、seccomp の後段適用、permission profile、実行サーバの capability token | Landlock legacy、transparent TCP、TUN 前提 |
| Claude Code の sandboxing | per-command とプロセス全体の境界を分ける、deny は全モードで有効 | シェルだけを sandbox にする（hns は全ツールがサーバ側） |
| [MCP 仕様](https://modelcontextprotocol.io/specification/2025-11-25) の authorization / annotations | tool 名の認可、annotations を hint として表示にだけ使う | annotations を強制に使う、stdio の資格情報 |
| [Progent](https://arxiv.org/abs/2504.11703) | ツール名 + 引数の決定論的規則、narrowing は自動・expansion は承認 | LLM がポリシーを生成する部分 |
| [CaMeL](https://arxiv.org/abs/2503.18813) | capability でデータフローを制限する考え方 | planner / executor の全面分離（Phase 1 では過大） |
| RFC 8785 (JCS) | canonical JSON とハッシュの安定性 | 浮動小数の全範囲（safe integer だけ） |
| WebCrypto | Ed25519 / ECDSA-P256 の検証 | 鍵の保存・配布（server の secret / machine の登録） |
| [Cedar](https://arxiv.org/abs/2403.04651) / [Zelkova](https://d1.awsstatic.com/Security/pdfs/Semantic_Based_Automated_Reasoning_for_AWS_Access_Policies_Using_SMT.pdf) | 能力集合の包含と差分の考え方 | 実行時の SMT（CI のみ、D090） |