/**
 * `@hns/core/capability`: the tool-call capability contract.
 *
 * @remarks
 * Types, strict schemas, canonical JSON (RFC 8785) and hashes, grant verification, the policy atom
 * algebra, the denial codes and their retry table, and the review token (`docs/capability.md` §3–§4,
 * D091). It has no key store, no HTTP, no database, and no `node:*` import: the server issues
 * grants, the machine verifies them, and both use this vocabulary. The web app does not import it.
 */

export * from "./types.ts";
export * from "./schemas.ts";
export * from "./canonical.ts";
export * from "./denial.ts";
export * from "./paths.ts";
export * from "./policy.ts";
export * from "./grant.ts";
