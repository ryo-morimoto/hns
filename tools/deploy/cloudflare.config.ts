import { bindings, defineConfig, exports } from "cf/config";
import { deploymentFor, gatewayWorkerName, type Deployment } from "./modes.ts";

/**
 * Build the Worker section for a deployment.
 *
 * @remarks
 * Kept separate from the default export so the binding set can be tested without evaluating
 * the cf config function or reading process.env. The provider keys are not declared here:
 * they belong to the gateway Worker only, and this env deliberately has no field for them.
 */
export const workerFor = (deployment: Deployment) => ({
  name: deployment.workerName,
  compatibilityDate: "2026-10-30",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "worker.ts",
  exports: {
    Session: exports.durableObject({ storage: "sqlite" }),
    Workspace: exports.durableObject({ storage: "sqlite" }),
  },
  env: {
    HNS_ENV: bindings.text(deployment.env),
    HNS_SESSION_SECRET: bindings.secret(),
    HNS_AGENT_URL: bindings.text(deployment.agentUrl),
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
  },
});

export default defineConfig(({ mode }) => {
  const deployment = deploymentFor(mode, process.env.HNS_AGENT_URL, process.env.HNS_MODEL);
  return { worker: workerFor(deployment) };
});
