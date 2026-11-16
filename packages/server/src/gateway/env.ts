import type { D1Binding } from "@hns/store";
import type { GatewayProvider, GatewayRoute } from "./providers.ts";

/**
 * The bindings and variables the gateway reads.
 *
 * @remarks
 * Every field is optional so a missing binding fails closed (503) instead of crashing the
 * isolate at startup. The provider keys exist only here: the harness Worker's env has no
 * field for them, and its deploy config declares no such secret.
 */
export interface GatewayEnv {
  /** The control database that holds the single budget row. */
  readonly DB?: D1Binding | undefined;
  /** USD charged for one model call; the budget compares this against the limits. */
  readonly HNS_GATEWAY_CALL_PRICE_USD?: string | undefined;
  readonly HNS_GATEWAY_OLLAMA_CLOUD_URL?: string | undefined;
  readonly HNS_GATEWAY_OPENCODE_GO_URL?: string | undefined;
  /** Ollama Cloud's key. Never logged, never returned. */
  readonly OLLAMA_CLOUD_API_KEY?: string | undefined;
  /** OpenCode Go's key. Never logged, never returned. */
  readonly OPENCODE_GO_API_KEY?: string | undefined;
}

/** A binding value that is present and not blank. */
const filled = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/**
 * Read the credential for a provider.
 *
 * @param env - The gateway's bindings.
 * @param provider - A provider from {@link GATEWAY_ROUTES}.
 * @returns The key, or undefined when the binding is absent or blank (the caller fails closed).
 */
export function credentialFor(env: GatewayEnv, provider: GatewayProvider): string | undefined {
  switch (provider) {
    case "ollama-cloud":
      return filled(env.OLLAMA_CLOUD_API_KEY);
    case "opencode-go":
      return filled(env.OPENCODE_GO_API_KEY);
    default: {
      const unhandled: never = provider;
      throw new Error("unknown provider: " + String(unhandled));
    }
  }
}

/**
 * Resolve the upstream endpoint for a route.
 *
 * @param env - The gateway's bindings.
 * @param route - The route selected by the request path.
 * @returns The override binding when set, otherwise the route's own endpoint.
 *
 * @throws Error when the resolved URL is neither https nor loopback. A plaintext upstream
 * would send the provider key in the clear, so it is refused rather than downgraded.
 */
export function upstreamFor(env: GatewayEnv, route: GatewayRoute): string {
  const provider = route.provider;
  switch (provider) {
    case "ollama-cloud":
      return requireSafeUrl(filled(env.HNS_GATEWAY_OLLAMA_CLOUD_URL) ?? route.upstream);
    case "opencode-go":
      return requireSafeUrl(filled(env.HNS_GATEWAY_OPENCODE_GO_URL) ?? route.upstream);
    default: {
      const unhandled: never = provider;
      throw new Error("unknown provider: " + String(unhandled));
    }
  }
}

/** Loopback hosts keep local dev and the integration test on plain http. */
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Check that an endpoint keeps the provider key off the wire in clear text.
 *
 * @internal
 * @param value - The endpoint to check.
 * @returns The URL unchanged.
 * @throws Error when the URL is unparsable, has another protocol, or is plaintext off loopback.
 */
function requireSafeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("the upstream URL is not a valid URL");
  }
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname)) return value;
  throw new Error("the upstream URL must be https or loopback");
}

/**
 * Read the per-call price the budget charges.
 *
 * @param env - The gateway's bindings.
 * @returns The positive USD amount, or undefined when unset or invalid (the caller fails closed).
 *
 * @remarks
 * The price is policy, not request data: it must be the highest per-call cost of the models
 * the deployment allows, so the budget bounds the money and the provider's own hard limit
 * is the outer fence.
 */
export function priceFor(env: GatewayEnv): number | undefined {
  const raw = filled(env.HNS_GATEWAY_CALL_PRICE_USD);
  if (raw === undefined) return undefined;
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) return undefined;
  return price;
}
