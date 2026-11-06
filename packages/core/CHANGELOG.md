# Changelog

## 0.1.0

- Domain types as the only source of truth (types.ts).
- HTTP wire contract: a route table with request, path-parameter, response, and stream schemas, and who may call each route.
- `SandboxStatus` is a discriminated union, so a refused probe cannot claim exec is on.
- `validateWorkflowGraph()` refuses duplicate nodes, dangling edges, and cycles.
