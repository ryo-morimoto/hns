import { bindings, defineConfig, exports } from "cf/config";

export interface Deployment {
  readonly mode: "development" | "staging" | "production";
  readonly env: "dev" | "stg" | "prod";
  readonly workerName: string;
  readonly agentUrl: string;
  readonly model: string;
}

const MODES = ["development", "staging", "production"] as const;
type Mode = (typeof MODES)[number];

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

export default defineConfig(({ mode }) => {
  const deployment = deploymentFor(mode, process.env.HNS_AGENT_URL, process.env.HNS_MODEL);
  return {
    worker: {
      name: deployment.workerName,
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "worker.ts",
      exports: {
        Session: exports.durableObject({ storage: "sqlite" }),
      },
      env: {
        HNS_ENV: bindings.text(deployment.env),
        HNS_AGENT_URL: bindings.text(deployment.agentUrl),
        HNS_MODEL: bindings.text(deployment.model),
        SESSION: bindings.durableObject({
          worker: deployment.workerName,
          exportName: "Session",
        }),
      },
    },
  };
});
