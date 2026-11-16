import { createGateway } from "./handler.ts";

/**
 * The provider gateway Worker.
 *
 * @remarks
 * A plain Worker: no Durable Object, no static assets. The harness reaches it through a
 * service binding and holds neither the provider key nor the provider URL; the key lives in
 * this Worker's secrets and the budget lives in the shared D1 database (D049). Deployed as
 * its own cf project under `tools/deploy/gateway` because one `cloudflare.config.ts`
 * describes one Worker.
 */
const gateway = createGateway();

export default { fetch: gateway };
