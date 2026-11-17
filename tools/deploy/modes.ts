/** The Cloudflare CLI modes this project deploys. */
export const MODES = ["development", "staging", "production"] as const;

/** One of the supported CLI modes. */
export type Mode = (typeof MODES)[number];

/** What one mode maps to: the Worker name, its agent URL, its model, and its custom domain. */
export interface Deployment {
  readonly mode: Mode;
  readonly env: "dev" | "stg" | "prod";
  readonly workerName: string;
  readonly agentUrl: string;
  readonly model: string;
  /**
   * The hostname the Worker is published to.
   *
   * @remarks
   * Absent in development, where the Worker stays on workers.dev (D094). Staging and
   * production require it, so a deploy cannot silently publish to the workers.dev host.
   */
  readonly domain?: string | undefined;
}

const ENV_BY_MODE: Record<Mode, { env: Deployment["env"]; workerName: string }> = {
  development: { env: "dev", workerName: "hns-dev" },
  staging: { env: "stg", workerName: "hns-stg" },
  production: { env: "prod", workerName: "hns-prod" },
};

const isMode = (value: string): value is Mode => MODES.some((mode) => mode === value);

const required = (value: string | undefined, name: string, mode: string): string => {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for mode ${mode}`);
  }
  return value;
};

const httpsUrl = (value: string, mode: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`HNS_AGENT_URL must be https for mode ${mode}`);
  }
  return value;
};

/**
 * Resolve the deployment for a Cloudflare CLI mode.
 *
 * @remarks
 * development is local and has defaults; staging and production require an https agent URL and a model.
 * An unknown mode throws instead of falling back to production.
 */
export const deploymentFor = (
  mode: string | undefined,
  agentUrl: string | undefined,
  model: string | undefined,
): Deployment => {
  if (mode === undefined) {
    throw new Error("--mode is required (development|staging|production)");
  }
  const selected = mode;
  if (!isMode(selected)) {
    throw new Error(`unknown mode: ${selected}`);
  }
  const { env, workerName } = ENV_BY_MODE[selected];
  if (env === "dev") {
    return {
      mode: selected,
      env,
      workerName,
      agentUrl: agentUrl ?? "http://127.0.0.1:8788",
      model: model ?? "faux/echo",
    };
  }
  return {
    mode: selected,
    env,
    workerName,
    agentUrl: httpsUrl(required(agentUrl, "HNS_AGENT_URL", selected), selected),
    model: required(model, "HNS_MODEL", selected),
  };
};

const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** Validate a custom domain; a URL, a path, or a bare label is rejected. */
const customDomain = (value: string, mode: string): string => {
  const host = value.toLowerCase();
  if (!HOSTNAME.test(host)) {
    throw new Error(`HNS_DOMAIN must be a hostname for mode ${mode}`);
  }
  return host;
};

/**
 * The custom domain for a mode.
 *
 * @param mode - The selected mode.
 * @param domain - `HNS_DOMAIN` from the environment.
 * @returns The hostname for staging and production; undefined in development.
 *
 * @remarks
 * Development and CI keep workers.dev (D094). Staging and production publish on a custom
 * domain only; a missing or malformed value throws instead of falling back to workers.dev.
 */
export const customDomainFor = (mode: Mode, domain: string | undefined): string | undefined => {
  if (mode === "development") return undefined;
  return customDomain(required(domain, "HNS_DOMAIN", mode), mode);
};

/**
 * The provider gateway's worker name for a deployment.
 *
 * @remarks
 * The gateway is a second Worker because one `cloudflare.config.ts` describes one Worker and
 * the keys must live in another isolate (see docs/auth.md). It shares the mode's D1 database,
 * so the budget row is the same control database (D049).
 */
export const gatewayWorkerName = (workerName: string): string => workerName + "-gateway";
