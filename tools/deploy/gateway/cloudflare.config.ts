import { bindings, defineConfig } from "cf/config";
import {
  GATEWAY_ROUTES,
  type GatewayRoute,
} from "../../../packages/server/src/gateway/providers.ts";
import { deploymentFor, gatewayWorkerName, type Deployment } from "../modes.ts";

/** The default per-call price when the deployment does not set one. */
export const DEFAULT_CALL_PRICE_USD = "0.01";

/**
 * Read a positive price from the environment, so a bad value fails at deploy time.
 *
 * @internal
 */
const priceFor = (value: string | undefined): string => {
  const price = value ?? DEFAULT_CALL_PRICE_USD;
  const parsed = Number(price);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("HNS_GATEWAY_CALL_PRICE_USD must be a positive number");
  }
  return price;
};

/**
 * Build the gateway Worker section for a deployment.
 *
 * @remarks
 * One Worker, two provider routes, no Durable Object and no route of its own: the harness
 * calls it through a service binding. Each route declares its credential as a secret and its
 * upstream as a text variable whose default is the provider's public endpoint; the request
 * cannot choose either. The D1 database is the mode's control database, where the single
 * budget row lives.
 */
export const gatewayWorkerFor = (
  deployment: Deployment,
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const credential = (route: GatewayRoute) => [route.credential, bindings.secret()] as const;
  const endpoint = (route: GatewayRoute) =>
    [
      route.upstreamVariable,
      bindings.text(environment[route.upstreamVariable] ?? route.upstream),
    ] as const;
  return {
    name: gatewayWorkerName(deployment.workerName),
    compatibilityDate: "2026-10-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "worker.ts",
    env: Object.fromEntries([
      ["HNS_ENV", bindings.text(deployment.env)],
      ["DB", bindings.d1({ name: deployment.workerName })],
      [
        "HNS_GATEWAY_CALL_PRICE_USD",
        bindings.text(priceFor(environment.HNS_GATEWAY_CALL_PRICE_USD)),
      ],
      ...GATEWAY_ROUTES.map(credential),
      ...GATEWAY_ROUTES.map(endpoint),
    ]),
  };
};

export default defineConfig(({ mode }) => {
  const deployment = deploymentFor(mode, process.env.HNS_AGENT_URL, process.env.HNS_MODEL);
  return { worker: gatewayWorkerFor(deployment, process.env) };
});
