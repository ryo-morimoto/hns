/**
 * The Artifacts mirror's kill switch: the one place that decides whether a mirror is attempted.
 *
 * @remarks
 * The mirror is a **two-way door** (D106): it can be switched off in production the moment it
 * misbehaves. Off is not a failure of the checkpoint. The Workspace object still makes the
 * checkpoint, still stores its pack, and still answers the prepare — it only stops handing out a
 * mirror target, so no push is attempted. A run whose mirror is off keeps the state it already had
 * (`pending` stays `pending`), so switching the mirror back on picks the run up instead of losing
 * the fact that it was never mirrored.
 *
 * **The unit is the workspace, and the default is the deployment** (U-02): the deploy's text
 * binding (`ARTIFACTS_MIRROR`) is what the operator sets once, and a workspace may override it in
 * its own storage. A switch read from a place that cannot be answered is **off**: the mirror is an
 * optional convenience, and a switch that cannot be read must not turn it on (fail closed).
 *
 * This module decides; it does not issue targets, read a binding, or write a row. The Workspace
 * object asks it once per prepare and once when a push reports, so one function answers whether a
 * mirror is attempted anywhere.
 */

/**
 * What the deploy says the mirror's default is.
 *
 * @remarks
 * The deploy's text binding is parsed here rather than compared at each use: the value is untrusted
 * text from the environment, and only the closed spellings turn the mirror on or off. Anything else
 * (absent, empty, `ON`, a typo) is `off`, because a switch that cannot be read must not enable a
 * push.
 */
export type MirrorDefault = "on" | "off";

/**
 * The switch as the deploy sets it.
 *
 * @param value - The deploy's `ARTIFACTS_MIRROR` text, or undefined when the binding is absent.
 * @returns `"on"` only for the exact word `on`; every other value, including an absent binding, is
 * `"off"`.
 *
 * @remarks
 * Fail closed, and deliberately strict: the switch is read by the deploy in one place
 * (tools/deploy/cloudflare.config.ts, which writes `on` or `off`), so a second spelling
 * (`yes`, `1`, `ON`) is a mistake to surface, not a value to interpret.
 */
export function mirrorDefaultFrom(value: string | undefined): MirrorDefault {
  return value === "on" ? "on" : "off";
}

/**
 * A workspace's override of the mirror's default.
 *
 * @remarks
 * Parsed from the value the workspace stored. Absent means "the deployment decides"; the two
 * spellings are the only overrides, and any other stored text is a value this build does not know,
 * so it is refused (treated as absent) rather than turned into a surprising switch.
 */
export type MirrorOverride = "on" | "off";

/**
 * Read a stored workspace override.
 *
 * @param value - The stored text, or undefined when the workspace has none.
 * @returns The override, or undefined when the workspace did not set one.
 *
 * @remarks
 * An unknown value is undefined, not `"off"`: a row this build cannot read must fall back to the
 * deployment's decision instead of silently freezing the workspace.
 */
export function mirrorOverrideFrom(value: string | undefined): MirrorOverride | undefined {
  return value === "on" || value === "off" ? value : undefined;
}

/** The settings the switch reads: the deployment's default and the workspace's own. */
export interface MirrorSwitchSettings {
  /** What the deploy says (`ARTIFACTS_MIRROR`), already parsed. */
  readonly default: MirrorDefault;
  /** The workspace's own value, when it set one. */
  readonly override?: MirrorOverride | undefined;
}

/**
 * Whether a mirror may be attempted.
 *
 * @param settings - The deployment's default and the workspace's override.
 * @returns True only when the workspace's override, or its absence and the default, says `on`.
 *
 * @remarks
 * **One decision.** Absent override means the deployment decides; a workspace override wins over
 * the deployment in both directions (it can turn the mirror off in a deployment that mirrors, and
 * on in one that does not, which is what "override" means). Nothing else in the object compares
 * `"on"`: a caller that asks this function cannot disagree with the prepare that issued a target.
 */
export function mirrorEnabled(settings: MirrorSwitchSettings): boolean {
  const decision = settings.override ?? settings.default;
  return decision === "on";
}

/**
 * The settings a Workspace object holds: the deployment's default, with the workspace's own when
 * its storage could be read.
 *
 * @param options - The switch as the object was constructed: the test seam `artifactsMirror`
 * wins over the binding when it is present, so a unit test can set the deployment's default.
 * @param stored - The workspace's stored override, or undefined when it has none or could not be
 * read.
 * @returns The settings {@link mirrorEnabled} reads.
 *
 * @remarks
 * The stored value is read once per decision (the Workspace object asks it on each prepare), so a
 * workspace that turns its mirror off stops the next prepare without a redeploy. A storage that
 * cannot answer the override is logged by the caller and leaves only the default: the mirror's
 * switch is never the reason a checkpoint fails.
 */
export function mirrorSettingsOf(
  options: {
    readonly artifactsMirror?: boolean | undefined;
    readonly ARTIFACTS_MIRROR?: string | undefined;
  },
  stored: string | undefined,
): MirrorSwitchSettings {
  const fallback = mirrorOverrideFrom(stored);
  const deployment: MirrorDefault =
    options.artifactsMirror === undefined
      ? mirrorDefaultFrom(options.ARTIFACTS_MIRROR)
      : options.artifactsMirror
        ? "on"
        : "off";
  return fallback === undefined
    ? { default: deployment }
    : { default: deployment, override: fallback };
}
