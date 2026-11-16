import { SDL_COMMAND, SDL_HEADER } from "@hns/server/graphql";

/** The artifact modules relay-compiler writes; each must carry the generated marker. */
const ARTIFACT_MARKER = /@generated SignedSource<<[0-9a-f]+>>/u;

/** One generated file, as read from the working tree. */
export interface GeneratedFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Check that the GraphQL artifacts are the ones codegen writes.
 *
 * @param files - Every file under `packages/web/src/__generated__` plus `schema.graphql`.
 * @returns One message per problem; an empty list means every file carries its generated header.
 *
 * @remarks
 * The signal is the header the tool writes, not the file body: a hand-edited artifact keeps the
 * header, and the next gate run regenerates it anyway. The check exists so a missing
 * `npm run codegen` fails loudly instead of leaving a stale artifact for the compiler to read.
 */
export function checkGenerated(files: readonly GeneratedFile[]): readonly string[] {
  const problems: string[] = [];
  const artifacts = files.filter((file) => file.path.includes("/__generated__/"));
  if (artifacts.length === 0) {
    problems.push("packages/web/src/__generated__ is empty; run npm run codegen");
  }
  for (const artifact of artifacts) {
    if (!ARTIFACT_MARKER.test(artifact.text)) {
      problems.push(artifact.path + " has no @generated header; run npm run codegen");
    }
  }
  const schema = files.find((file) => file.path.endsWith("packages/web/schema.graphql"));
  if (schema === undefined) {
    problems.push("packages/web/schema.graphql is missing; run npm run codegen");
  } else {
    if (!schema.text.startsWith(SDL_HEADER)) {
      problems.push("packages/web/schema.graphql does not start with the generated header");
    }
    if (!schema.text.includes(SDL_COMMAND)) {
      problems.push("packages/web/schema.graphql does not name the regeneration command");
    }
  }
  return problems;
}
