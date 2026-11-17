import { SIGNATURE_HEADER, SIGNED_FIELD_BY_HEADER } from "@hns/core";
import * as v from "valibot";

/**
 * The machine agent's wire shapes this Worker reads.
 *
 * @remarks
 * The server may import core, agent, store, and workspace only (docs/packages.md), so it cannot
 * read `@hns/machine`'s parsers. These are the pieces of that package's wire contract the
 * checkpoint path needs: the six signed headers and the checkpoint request body. When the
 * machine package's contract changes, this file changes with it.
 *
 * None of this authenticates anything. The signature over these fields is checked against the
 * machine's **device key** ({@link verifyDeviceRequest}), which is the machine-to-Worker
 * direction (docs/contracts/auth.md); the machine package's `RequestVerifier` is the other
 * direction and is never used here.
 */

/** The `op` a checkpoint request carries. */
const CHECKPOINT_OP = "checkpoint";

/**
 * The signed headers as the agent writes them: every field is a non-empty string.
 *
 * @remarks
 * The names come from core's one header-to-field map. `Headers` joins a repeated header with
 * `", "`, so a duplicated one fails this parse rather than being guessed at.
 */
const SignedHeadersSchema = v.object({
  machineId: v.pipe(v.string(), v.minLength(1)),
  connection: v.pipe(v.string(), v.minLength(1)),
  seq: v.pipe(v.string(), v.minLength(1)),
  timestamp: v.pipe(v.string(), v.minLength(1)),
  nonce: v.pipe(v.string(), v.minLength(1)),
  signature: v.pipe(v.string(), v.minLength(1)),
});

/** The signed headers of one request. */
export type SignedHeaders = v.InferOutput<typeof SignedHeadersSchema>;

/**
 * Read the signed headers off a request.
 *
 * @param headers - The inbound headers.
 * @returns The fields, or undefined when one is missing or empty.
 */
export function signedHeadersOf(headers: Headers): SignedHeaders | undefined {
  const raw: Record<string, string> = {};
  for (const [header, field] of Object.entries(SIGNED_FIELD_BY_HEADER)) {
    raw[field] = headers.get(header) ?? "";
  }
  raw.signature = headers.get(SIGNATURE_HEADER) ?? "";
  const parsed = v.safeParse(SignedHeadersSchema, raw);
  return parsed.success ? parsed.output : undefined;
}

/**
 * The body of one checkpoint request.
 *
 * @param runId - The Run to checkpoint.
 * @returns The JSON text the agent parses.
 */
export function checkpointRequestBody(runId: string): string {
  return JSON.stringify({ op: CHECKPOINT_OP, runId });
}
