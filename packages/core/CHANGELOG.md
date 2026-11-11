# Changelog

## 0.1.0

- Domain types as the only source of truth (types.ts).
- GraphQL SDL is projected from the model (`./graphql`); core has no HTTP wire contract.
- `IsoTimestamp` / `OperationId` codecs.
- Durability contract vocabulary: failure classes, authorities, `CheckpointRef`, `DurableUnit`.
- `validateWorkflowGraph()` refuses duplicate nodes, dangling edges, and cycles.
