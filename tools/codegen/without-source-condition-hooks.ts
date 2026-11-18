/** A resolve hook: drop the `source` condition for packages that ship only `dist`. */
import type { ResolveHook } from "node:module";

const THIRD_PARTY = "@earendil-works/";

/** Resolve `specifier` from `context`, without the source condition for the third-party packages. */
export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  if (!specifier.startsWith(THIRD_PARTY)) return nextResolve(specifier, context);
  return nextResolve(specifier, {
    ...context,
    conditions: context.conditions.filter((condition) => condition !== "source"),
  });
};
