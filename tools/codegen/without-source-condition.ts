/**
 * Registers the resolve hook that drops the `source` condition for `@earendil-works/*`.
 *
 * @remarks
 * The gate's codegen stage runs `node --conditions=source` so it reads the worktree's own packages
 * rather than the `dist` a sibling checkout left behind. The `@earendil-works/*` tarballs publish a
 * `source` condition too, but ship only `dist`; resolving it would look for a `src/` that is not there.
 */
import { register } from "node:module";

register(new URL("./without-source-condition-hooks.ts", import.meta.url));
