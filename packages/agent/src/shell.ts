import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/**
 * Whether exec is offered at all. The agent never falls back to an unsandboxed
 * shell: with "disabled" the bash tool is not registered (docs/safety.md).
 */
export type ShellAccess =
  | { readonly kind: "sandboxed"; readonly env: ExecutionEnv }
  | { readonly kind: "disabled"; readonly env: ExecutionEnv; readonly reason: string };
