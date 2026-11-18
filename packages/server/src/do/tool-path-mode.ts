/**
 * Which tool path a deployment's environment asks for (0270n).
 *
 * @remarks
 * The granted tool path (0226) is opened by three bindings together: the machine's origin
 * (`HNS_AGENT_URL`), the machine's id (`HNS_MACHINE_ID`), and the control-plane key the relay and
 * the grants are signed with (`HNS_CONTROL_PLANE_KEY`). The issue that started this path left the
 * failure mode open: an object that saw only some of the three quietly kept the Phase 0 tools, so
 * a deployment could appear to run the granted path while every call was decided by the model
 * alone.
 *
 * This module is the one place that reads them as a set:
 *
 * - **all three present** — the granted path;
 * - **all three absent** — Phase 0 (the agent's own tools, no grant, no relay);
 * - **anything in between** — a **configuration error**, raised at start so the deployment fails
 *   loudly instead of falling back. A partly configured machine is the dangerous state: on the
 *   Worker it means grants are never issued, and on the Session object it means a run whose
 *   send carries a policy snapshot still gets no granted path.
 *
 * The check reports names, never values: a missing binding is named, a present one is not
 * described.
 */

/** The three bindings that make up the granted tool path, in the order they are reported. */
export const TOOL_PATH_BINDINGS = [
  "HNS_AGENT_URL",
  "HNS_MACHINE_ID",
  "HNS_CONTROL_PLANE_KEY",
] as const;

/** One of the three bindings. */
export type ToolPathBinding = (typeof TOOL_PATH_BINDINGS)[number];

/** What the environment asks for. */
export type ToolPathMode =
  | { readonly kind: "granted" }
  | { readonly kind: "phase0" }
  | {
      readonly kind: "incomplete";
      /** The bindings that are absent; never empty. */
      readonly missing: readonly ToolPathBinding[];
      /** The bindings that are present; never empty. */
      readonly present: readonly ToolPathBinding[];
    };

/** The slice of an environment the check reads. */
export interface ToolPathEnv {
  readonly HNS_AGENT_URL?: string | undefined;
  readonly HNS_MACHINE_ID?: string | undefined;
  readonly HNS_CONTROL_PLANE_KEY?: string | undefined;
}

/**
 * Whether a binding holds a value.
 *
 * @param value - The binding's value.
 * @returns False for undefined and for the empty string: a binding set to `""` is a value the
 * deployment did not fill in, which is absent for every purpose this module decides.
 */
const present = (value: string | undefined): boolean => value !== undefined && value.length > 0;

/**
 * Decide which tool path an environment asks for.
 *
 * @param env - The bindings, as the Worker or the Session object reads them.
 * @returns `granted`, `phase0`, or `incomplete` with the names that are missing and present.
 *
 * @remarks
 * Never throws and never reads a value beyond "absent or not", so a caller can use it at start
 * (where it may raise its own error) and in a test (where it may assert the decision).
 */
export function toolPathMode(env: ToolPathEnv): ToolPathMode {
  const missing = TOOL_PATH_BINDINGS.filter((name) => !present(env[name]));
  const there = TOOL_PATH_BINDINGS.filter((name) => present(env[name]));
  if (missing.length === 0) return { kind: "granted" };
  if (there.length === 0) return { kind: "phase0" };
  return { kind: "incomplete", missing, present: there };
}

/**
 * The message a start refuses a partly configured deployment with.
 *
 * @param mode - An `incomplete` decision.
 * @returns One sentence naming what is missing and what is set; never a value.
 *
 * @remarks
 * A person has to be able to tell which binding to add or remove from this line, so both lists
 * are spelled. The three together turn the granted path on, none of them keeps the Phase 0 tools,
 * and a mixture is this error.
 */
export function incompleteToolPathMessage(
  mode: Extract<ToolPathMode, { kind: "incomplete" }>,
): string {
  return (
    "the tool path is partly configured: " +
    mode.missing.join(", ") +
    " is not set while " +
    mode.present.join(", ") +
    " is. Set all three (" +
    TOOL_PATH_BINDINGS.join(", ") +
    ") to grant tools, or none of them to keep the Phase 0 tools."
  );
}
