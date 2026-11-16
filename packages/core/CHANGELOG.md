# Changelog

## 0.1.0

- Domain types as the only source of truth (types.ts).
- GraphQL SDL is projected from the model (`./graphql`); core has no HTTP wire contract.
- `IsoTimestamp` / `OperationId` codecs.
- Durability contract vocabulary: failure classes, authorities, `CheckpointRef`, `DurableUnit`.
- Lease contract: `WorkspaceLease` and the `LEASE_REFUSALS` vocabulary.
- `validateWorkflowGraph()` refuses duplicate nodes, dangling edges, and cycles.
- `toGlobalId()` / `fromGlobalId()` (`./graphql`) keep ids unique across GraphQL types.
