import type { PolicyDocument, PolicyTools, ToolPolicy } from "@hns/core/capability";
import { policyHash } from "@hns/core/capability";

/**
 * Which tools a workspace's revision 1 may switch on.
 *
 * @remarks
 * `bashSandbox` says whether the machine this workspace targets has a sandbox to run a process
 * in. Only then does the default turn `bash` on, and only with `network: "none"` and a read-only
 * workspace envelope (`docs/capability.md` §6). The fact is passed in rather than probed here:
 * the Worker has no machine to ask at the point a policy is created.
 */
export interface BaselineInput {
  readonly bashSandbox: boolean;
}

/**
 * A grant ceiling for a tool: how long a grant lives and how many calls it covers.
 *
 * @internal
 * @remarks
 * These are the envelope's defaults, not a proposal's choice: a proposal changes what a tool may
 * reach, not how many times it may be called. Phase 1 issues grants per session, so the ceiling
 * is small on both sides.
 */
const GRANT_TTL_SECONDS = 60;
const MAX_CALLS_PER_GRANT = 10;

/**
 * The tool policy the root scope pairs with.
 *
 * @internal
 */
function toolPolicy(scope: ToolPolicy["scope"]): ToolPolicy {
  return {
    enabled: true,
    scope,
    grantTtlSeconds: GRANT_TTL_SECONDS,
    maxCallsPerGrant: MAX_CALLS_PER_GRANT,
  };
}

/**
 * The document revision 1 records for a workspace.
 *
 * @param input - Whether the workspace has a sandbox for `bash`.
 * @returns The baseline: `read_file` and `write_file` over the workspace root (`"."`), `bash`
 * as `{kind: "exec", network: "none", writable: false}` when a sandbox exists and absent otherwise,
 * and egress disabled.
 *
 * @remarks
 * Every workspace starts with the same baseline, so a new workspace changes no capability by
 * being created. Disabling egress is not the same as listing no hosts: `enabled: false` is what
 * `capabilityAtoms` reads as "no egress atom" regardless of `hosts`.
 */
export function baselineDocument(input: BaselineInput): PolicyDocument {
  const tools: PolicyTools = {
    read_file: toolPolicy({ kind: "read", roots: ["."] }),
    write_file: toolPolicy({ kind: "write", roots: ["."] }),
  };
  const document: PolicyDocument = {
    v: 1,
    tools: input.bashSandbox
      ? { ...tools, bash: toolPolicy({ kind: "exec", network: "none", writable: false }) }
      : tools,
    egress: { enabled: false, hosts: [] },
  };
  return document;
}

/**
 * The document's hash, or `undefined` when the contract cannot canonicalize it.
 *
 * @remarks
 * A document whose bytes have no canonical form has no identity, and a proposal without an
 * identity cannot be reviewed: the caller reports `unsupported` instead of storing a row no
 * approval could ever match.
 *
 * @param document - The candidate or the baseline.
 * @throws Never; a canonicalization failure becomes `undefined`.
 */
export async function documentHash(document: PolicyDocument): Promise<string | undefined> {
  try {
    return await policyHash(document);
  } catch {
    return undefined;
  }
}
