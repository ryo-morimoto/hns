import * as v from "valibot";
import type { JsonValue } from "@hns/core";
import type { GraphQLCall } from "./relay.ts";

/**
 * The office face's wire, as the published schema spells it.
 *
 * @remarks
 * The panel tests name a row the way the server answers it (enum spellings in capitals, a version,
 * and an error object or null), because the operation selects exactly these fields. A member is
 * typed here rather than written inline so a test can build one state from another.
 */
export type PreviewRow =
  | {
      readonly __typename: "DocumentPreview";
      readonly status: string;
      readonly url: string | null;
      readonly pages: number | null;
      readonly bytes: number | null;
      readonly version: string;
      readonly error: { readonly code: string; readonly message: string } | null;
    }
  | {
      readonly __typename: "OfficeFailure";
      readonly code: string;
      readonly message: string;
    };

/**
 * A `DocumentPreview` member.
 *
 * @param status - The GraphQL enum spelling (`QUEUED`, `READY`, …).
 * @param facts - The fields the state has; anything omitted is null.
 */
export function previewRow(
  status: string,
  facts: {
    readonly bytes?: number | null;
    readonly pages?: number | null;
    readonly url?: string | null;
    readonly version?: string;
    readonly code?: string;
  } = {},
): PreviewRow {
  return {
    __typename: "DocumentPreview",
    status,
    url: facts.url ?? null,
    pages: facts.pages ?? null,
    bytes: facts.bytes ?? null,
    version: facts.version ?? "sha256:0",
    error:
      facts.code === undefined
        ? null
        : {
            code: facts.code,
            // An operator's prose, which the panel must never show (C3): the tests assert it does
            // not reach the screen.
            message: "operator-only prose about the engine",
          },
  };
}

/** The failure union member for one code. */
export function officeFailure(
  code: string,
  message = "operator-only prose about the engine",
): PreviewRow {
  return { __typename: "OfficeFailure", code, message };
}
