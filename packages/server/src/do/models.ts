import type { Models } from "@earendil-works/pi-ai/models";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { SessionEnv } from "./state.ts";

/** A model configuration that the Session cannot run yet. */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** The models and the model reference one Session runs on. */
export interface SessionModel {
  readonly models: Models;
  readonly model: ModelRef;
}

/**
 * Build the development faux model.
 *
 * @param env - The Worker bindings; only `HNS_ENV` and `HNS_MODEL` are read.
 * @returns The model registry and the reference every conversation is configured with.
 * @throws ModelUnavailableError for staging / production, or any non-faux model.
 *
 * @remarks
 * 0146 runs faux only. A real provider arrives with the gateway; until then a deployment
 * without a runnable model fails closed at open instead of admitting work it cannot finish.
 */
export function modelsFor(env: SessionEnv): SessionModel {
  if (env.HNS_ENV !== "dev") {
    throw new ModelUnavailableError("a model is available only in development");
  }
  const raw = env.HNS_MODEL ?? "faux/echo";
  const separator = raw.indexOf("/");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new ModelUnavailableError("HNS_MODEL must be <provider>/<model>");
  }
  const provider = raw.slice(0, separator);
  const modelId = raw.slice(separator + 1);
  if (provider !== "faux") {
    throw new ModelUnavailableError("only the faux provider is available in development");
  }
  const faux = fauxProvider({ provider, models: [{ id: modelId }] });
  const respond = () => {
    faux.appendResponses([respond]);
    return fauxAssistantMessage("faux response");
  };
  faux.setResponses([respond]);
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: { provider, modelId } };
}
