# Changelog

## 0.1.0

- Domain types as the only source of truth (types.ts).
- GraphQL SDL is projected from the model (`./graphql`); core has no HTTP wire contract.
- `IsoTimestamp` / `OperationId` codecs.
- Durability contract vocabulary: failure classes, authorities, `CheckpointRef`, `DurableUnit`.
- Lease contract: `WorkspaceLease` and the `LEASE_REFUSALS` vocabulary.
- `validateWorkflowGraph()` refuses duplicate nodes, dangling edges, and cycles.
- `toGlobalId()` / `fromGlobalId()` (`./graphql`) keep ids unique across GraphQL types.
- Tool-call capability contract (`./capability`): `ToolManifest`, `ToolCall`, `CallDigest`, `CapabilityScope`,
  `GrantPayload`, `SignedGrant`, `PolicyDocument`, `PolicyRevision`, `PolicyProposal`, `PolicyDecision`,
  `AuditEvent` with strict valibot schemas; RFC 8785 `canonicalize` and `argsHash` / `callHash` /
  `manifestHash` / `policyHash` / `reviewToken`; `authorizeCall` (Ed25519 and ECDSA-P256 via WebCrypto);
  `capabilityAtoms` / `diffPolicy` / `isUnder`; `DENIAL_CODES` with `DENIAL_RETRY`.
