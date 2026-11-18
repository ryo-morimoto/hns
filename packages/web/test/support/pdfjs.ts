/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type --
   The two constructors are patched on purpose: `pdfjs-dist` 6 calls helpers the running engine
   does not have yet (`toHex`, `toBase64`, `fromHex`, `fromBase64`), and the patch writes onto
   `Uint8Array` whose static side the lib types leave closed. */
import { beforeAll } from "vitest";

/** The four helpers PDF.js's build expects from the platform, filled for the test runner. */
type ByteHelpers = {
  toHex?: (this: Uint8Array) => string;
  toBase64?: (this: Uint8Array) => string;
  fromHex?: (hex: string) => Uint8Array;
  fromBase64?: (base64: string) => Uint8Array;
};

/**
 * The few globals PDF.js's `build/` expects from a current engine, for the test runner.
 *
 * @remarks
 * `pdfjs-dist` 6 is built for the platform's own `Uint8Array` helpers; Node 24 and jsdom's realm
 * have none of them, so importing the real `pdfjs-dist` throws. These are the same answers over
 * the same bytes, so a test still exercises the production reader rather than a stand-in for it.
 */
export function fillPdfjsGlobals(): void {
  const proto = Uint8Array.prototype as Uint8Array & ByteHelpers;
  proto.toHex ??= function toHex(this: Uint8Array): string {
    let hex = "";
    for (const byte of this) hex += byte.toString(16).padStart(2, "0");
    return hex;
  };
  proto.toBase64 ??= function toBase64(this: Uint8Array): string {
    let binary = "";
    for (const byte of this) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const constructor = Uint8Array as unknown as {
    fromHex?: ByteHelpers["fromHex"];
    fromBase64?: ByteHelpers["fromBase64"];
  };
  constructor.fromHex ??= (hex: string): Uint8Array => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  };
  constructor.fromBase64 ??= (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
}

beforeAll(fillPdfjsGlobals);
