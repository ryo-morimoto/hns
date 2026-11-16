/**
 * The provider gateway's Worker entrypoint.
 *
 * @remarks
 * The gateway lives in `@hns/server` next to the edge; this file re-exports it so the cf
 * project keeps one entrypoint. The relative import is deliberate: tools/deploy is not a
 * workspace package, and the gateway is bundled from source like the main Worker.
 */
export { default } from "../../../packages/server/src/gateway/index.ts";
