import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/**
 * Whether exec is offered at all. The agent never falls back to an unsandboxed
 * shell: with "disabled" the bash tool is not registered (docs/safety.md).
 *
 * @remarks
 * Both variants carry `env` because the harness is composed with one. With "disabled"
 * nothing in this package runs a command through it, and a host that cannot sandbox
 * exec records `reason` instead of offering a bare shell.
 */
export type ShellAccess =
  /** bash runs through this sandboxed environment. */
  | { readonly kind: "sandboxed"; readonly env: ExecutionEnv }
  /** No exec: the bash tool is absent, and `reason` goes to logs and the UI. */
  | { readonly kind: "disabled"; readonly env: ExecutionEnv; readonly reason: string };
