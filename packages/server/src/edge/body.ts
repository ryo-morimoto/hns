/** A body read succeeded or failed with a caller-actionable reason. */
export type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "payload_too_large" | "unsupported_media_type" };

/**
 * Read a JSON request body up to a byte limit.
 *
 * @param request - The inbound request.
 * @param maxBytes - The limit in bytes.
 * @returns The decoded text, or a typed failure.
 *
 * @remarks
 * The limit is checked twice: against a declared `Content-Length` so an oversized request is
 * rejected without reading it, and against the streamed bytes so a lying header cannot get
 * through. The body is consumed here; handlers receive the text, not the original stream.
 */
export async function readBody(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return { ok: false, code: "unsupported_media_type" };
  }
  const length = request.headers.get("content-length");
  if (length !== null) {
    const declared = Number.parseInt(length, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, code: "payload_too_large" };
    }
  }
  const stream = request.body;
  if (stream === null) return { ok: true, text: "" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The stream is already closing; the size failure is the result that matters.
      }
      return { ok: false, code: "payload_too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
