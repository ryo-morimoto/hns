/**
 * The machine's capability verifier: it decides every granted call locally (0225).
 *
 * @remarks
 * `verifyGrant` is the pure decision (the contract's `authorizeCall` plus the machine's own facts),
 * `GrantCounter` is the stateful budget (`docs/capability.md` §5's `consume`), `authorizeGrantedCall`
 * is both in the order a caller must use them, and `enrolledGrantKeys` / `fetchControlPlaneKeys`
 * are how the machine reaches the control-plane key a grant names. The RPC that carries the grant is
 * 0226; this package does not listen or fetch for itself.
 */

export { GrantCounter, isStateGrantId } from "./counter.ts";
export type { ConsumeInput, ConsumeResult, GrantSpend } from "./counter.ts";
export { enrolledGrantKeys, fetchControlPlaneKeys, grantKeyId } from "./keys.ts";
export type { GrantKeyLookup, GrantKeys } from "./keys.ts";
export { verifyDenialOf, verifyGrant } from "./verify.ts";
export type { VerifyGrantInput, VerifyGrantResult } from "./verify.ts";
export { authorizeGrantedCall, mayRetry } from "./decision.ts";
export type { AuthorizeGrantedCallInput, AuthorizeGrantedCallResult } from "./decision.ts";
