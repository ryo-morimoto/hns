import { bindings, defineConfig, exports, type WorkerConfig } from "cf/config";
import { customDomainFor, deploymentFor, gatewayWorkerName, type Deployment } from "./modes.ts";

/** The worker always declares its bindings and exports; the base type makes both optional. */
type DeployedWorker = WorkerConfig & {
  readonly env: NonNullable<WorkerConfig["env"]>;
  readonly exports: NonNullable<WorkerConfig["exports"]>;
};

/**
 * Build the Worker section for a deployment.
 *
 * @remarks
 * Kept separate from the default export so the binding set can be tested without evaluating
 * the cf config function or reading process.env. The provider keys are not declared here:
 * they belong to the gateway Worker only, and this env deliberately has no field for them.
 * The edge routes every request first (`runWorkerFirst`) and serves assets through the
 * `ASSETS` binding, because the API and WebSocket faces must stay ahead of the static
 * fallback (D094). A custom domain is set for staging and production; development keeps
 * workers.dev. Preview URLs are always off.
 */
export const workerFor = (deployment: Deployment): DeployedWorker => {
  const worker: DeployedWorker = {
    name: deployment.workerName,
    compatibilityDate: "2026-10-30",
    compatibilityFlags: ["nodejs_compat"],
    entrypoint: "worker.ts",
    workersDev: deployment.domain === undefined,
    previewUrls: false,
    assets: {
      notFoundHandling: "none",
      runWorkerFirst: true,
    },
    exports: {
      Session: exports.durableObject({ storage: "sqlite" }),
      Workspace: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      HNS_ENV: bindings.text(deployment.env),
      HNS_SESSION_SECRET: bindings.secret(),
      // The machine's origin; the Workspace object calls it through the tunnel.
      HNS_AGENT_URL: bindings.text(deployment.agentUrl),
      // The control-plane key the Worker signs machine requests with (D100). The public half is
      // enrolled on the machine; the registry that supplies both is 0148's.
      HNS_CONTROL_PLANE_KEY: bindings.secret(),
      HNS_MODEL: bindings.text(deployment.model),
      SESSION: bindings.durableObject({
        worker: deployment.workerName,
        exportName: "Session",
      }),
      WORKSPACE: bindings.durableObject({
        worker: deployment.workerName,
        exportName: "Workspace",
      }),
      DB: bindings.d1({ name: deployment.workerName }),
      // The workspace objects (git blobs and checkpoint packs); one bucket per environment.
      OBJECTS: bindings.r2({ name: deployment.workerName + "-objects" }),
      // The harness reaches the model through this binding and holds neither the key nor the URL.
      GATEWAY: bindings.worker({ worker: gatewayWorkerName(deployment.workerName) }),
      // The web build (`npm run build -w @hns/web`) writes deploy/assets; the edge serves it.
      ASSETS: bindings.assets(),
      // The Artifacts namespace that holds one mirror repository per workspace (0246). The
      // Workspace object creates the repository lazily and issues a short-lived push token from it.
      ARTIFACTS: bindings.artifacts({ namespace: deployment.workerName }),
      // The mirror's kill switch: "on" mirrors, anything else does not. The mirror is never on
      // the checkpoint's path, so switching it off changes no acknowledgement.
      ARTIFACTS_MIRROR: bindings.text(process.env.ARTIFACTS_MIRROR === "on" ? "on" : "off"),
    },
  };
  return deployment.domain === undefined ? worker : { ...worker, domains: [deployment.domain] };
};

export default defineConfig(({ mode }) => {
  const base = deploymentFor(mode, process.env.HNS_AGENT_URL, process.env.HNS_MODEL);
  const deployment: Deployment = {
    ...base,
    domain: customDomainFor(base.mode, process.env.HNS_DOMAIN),
  };
  return { worker: workerFor(deployment) };
});
