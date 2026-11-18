import {
  GraphQLEnumType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  GraphQLUnionType,
  type GraphQLFieldConfigMap,
  type GraphQLFieldResolver,
} from "graphql";
import { OFFICE_ERROR_CODES, PREVIEW_STATUSES } from "@hns/core/office";
import type { OfficeErrorCode } from "@hns/core/office";
import type { GraphQLContext } from "./context.ts";
import type { DocumentPreviewView, OfficeEngineView, OfficeFailureView } from "../do/office-job.ts";
import { officeFailureOf } from "../do/office-job.ts";
import type { WorkspaceVersion } from "./office-version.ts";

/** The union member a preview failure is: the object's own failure, named by its type. */
export type OfficeFailureUnionView = OfficeFailureView;

/** What `documentPreview` and `requestDocumentPreview` answer. */
export type DocumentPreviewResult = DocumentPreviewView | OfficeFailureUnionView;

/** What `officeEngine` answers. */
export type OfficeEngineResult = OfficeEngineView | OfficeFailureUnionView;

/**
 * The `officeEngine` failure a session without a machine answers.
 *
 * @remarks
 * A deployment with no machine is not a request that failed: it is an engine that is not there,
 * which is the union's own `OfficeEngineUnavailable` member. The failure member is for a machine
 * that could not be asked, which is a different thing a person acts on differently.
 */
export const OFFICE_ENGINE_NO_MACHINE: OfficeEngineView = {
  __typename: "OfficeEngineUnavailable",
  reason: "This session has no machine to ask.",
};

/** The office failure union member for one code and message. */
export function officeFailure(code: OfficeErrorCode, message: string): OfficeFailureUnionView {
  return officeFailureOf(code, message);
}

/**
 * The office face's GraphQL types (0237 §6).
 *
 * @remarks
 * `not_authorized` is a member of the **failure union**, not an eighth `PreviewStatus`: the seven
 * states describe a job, and a path the session may not read has no job. Building the types here
 * (rather than in the model) keeps one owner for the office face's names, so the Query fields and
 * the Mutation field cannot disagree about them.
 */
export const OfficeErrorCodeType = new GraphQLEnumType({
  name: "OfficeErrorCode",
  values: Object.fromEntries(
    OFFICE_ERROR_CODES.map((code) => [code.toUpperCase(), { value: code }]),
  ),
});

/** The seven preview states, spelled as the contract names them. */
export const PreviewStatusType = new GraphQLEnumType({
  name: "PreviewStatus",
  values: Object.fromEntries(
    PREVIEW_STATUSES.map((status) => [status.toUpperCase(), { value: status }]),
  ),
});

/**
 * The office failure: a closed code and a message.
 *
 * @remarks
 * It is its own type rather than the GraphQL face's `QueryFailure`: the codes are the contract's
 * (`office.md` §9), and a caller branches on them to decide what to tell a person.
 */
export const OfficeFailureType = new GraphQLObjectType({
  name: "OfficeFailure",
  fields: {
    code: { type: new GraphQLNonNull(OfficeErrorCodeType) },
    message: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** One preview row, as a screen reads it. */
export const DocumentPreviewType = new GraphQLObjectType({
  name: "DocumentPreview",
  fields: {
    path: { type: new GraphQLNonNull(GraphQLString) },
    version: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: new GraphQLNonNull(PreviewStatusType) },
    url: { type: GraphQLString },
    pages: { type: GraphQLInt },
    bytes: { type: GraphQLInt },
    missingFonts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    },
    engine: { type: GraphQLString },
    generatedAt: { type: GraphQLString },
    error: { type: OfficeFailureType },
  },
});

/** What a preview read and a preview request answer. */
export const DocumentPreviewResultType = new GraphQLUnionType({
  name: "DocumentPreviewResult",
  types: [DocumentPreviewType, OfficeFailureType],
  resolveType: (value: DocumentPreviewResult): string => value.__typename,
});

/** The engine a machine reports. */
export const OfficeEngineAvailableType = new GraphQLObjectType({
  name: "OfficeEngineAvailable",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    version: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** Why a machine runs no office job. */
export const OfficeEngineUnavailableType = new GraphQLObjectType({
  name: "OfficeEngineUnavailable",
  fields: {
    reason: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** The engine probe's answer. */
export const OfficeEngineType = new GraphQLUnionType({
  name: "OfficeEngine",
  types: [OfficeEngineAvailableType, OfficeEngineUnavailableType, OfficeFailureType],
  resolveType: (value: OfficeEngineResult): string => value.__typename,
});

/**
 * The previews of one session, from the object that owns the rows and the alarm (0237).
 *
 * @remarks
 * A port on the context, like the other faces: production forwards to the Session object the
 * project's conversations live on (its `/rpc/office…` routes), and a resolver test replaces it.
 * **A resolver never runs a job**: `request` writes a row and answers, and `preview` reads one.
 */
export interface OfficePort {
  /** The stored row for one file, or undefined when none was asked for. */
  preview(
    workspaceId: string,
    path: string,
    workspaceVersion: string | undefined,
  ): Promise<DocumentPreviewView | OfficeFailureView | undefined>;
  /** Ask for one file's preview; the answer is the row the request wrote or reused. */
  request(
    workspaceId: string,
    path: string,
    workspaceVersion: string | undefined,
  ): Promise<DocumentPreviewView | OfficeFailureView>;
  /** What engine the session's machine has. */
  engine(workspaceId: string): Promise<OfficeEngineView | OfficeFailureView>;
  /**
   * The version one file has now.
   *
   * @returns The version, or the office failure that says why it could not be read. **Never**
   * `source_changed`: a version this face could not read is not a file that changed.
   */
  workspaceVersion(workspaceId: string, path: string): Promise<WorkspaceVersion>;
}

/** The arguments a preview field takes. */
interface PreviewArgs {
  readonly path: string;
  readonly workspaceId?: string | undefined;
}

/** The workspace a field acts in: the argument when given, else the session's own project. */
function workspaceOf(args: PreviewArgs): string {
  return args.workspaceId ?? "";
}

/** One answer as the union: a row passes through, a failure becomes the union's member. */
function toResult(answer: DocumentPreviewView | OfficeFailureView): DocumentPreviewResult {
  if (answer.__typename === "DocumentPreview") return answer;
  return officeFailure(answer.code, answer.message);
}

/** The `documentPreview` field: reads the row and nothing else. */
export const documentPreviewResolver: GraphQLFieldResolver<
  undefined,
  GraphQLContext,
  PreviewArgs
> = async (_source, args, context): Promise<DocumentPreviewResult> => {
  const workspaceId = workspaceOf(args);
  if (workspaceId === "") {
    return officeFailure("not_authorized", "The workspace is not known.");
  }
  const read = await context.office.workspaceVersion(workspaceId, args.path);
  if (!read.ok) return officeFailure(read.failure.code, read.failure.message);
  const answer = await context.office.preview(workspaceId, args.path, read.version);
  if (answer === undefined) {
    // No row: the preview was never asked for. The read answers the state a person acts on by
    // requesting one, and the failure union has no code for "nothing yet".
    return officeFailure("engine_unavailable", "No preview has been requested for this file.");
  }
  return toResult(answer);
};

/** The `requestDocumentPreview` field: writes a row and answers at once (C3). */
export const requestDocumentPreviewResolver: GraphQLFieldResolver<
  undefined,
  GraphQLContext,
  PreviewArgs
> = async (_source, args, context): Promise<DocumentPreviewResult> => {
  const workspaceId = workspaceOf(args);
  if (workspaceId === "") {
    return officeFailure("not_authorized", "The workspace is not known.");
  }
  const read = await context.office.workspaceVersion(workspaceId, args.path);
  if (!read.ok) return officeFailure(read.failure.code, read.failure.message);
  const answer = await context.office.request(workspaceId, args.path, read.version);
  return toResult(answer);
};

/** The `officeEngine` field: what the session's machine reports. */
export const officeEngineResolver: GraphQLFieldResolver<undefined, GraphQLContext, object> = async (
  _source,
  args: { readonly workspaceId?: string | undefined },
  context,
): Promise<OfficeEngineResult> => {
  const workspaceId = args.workspaceId ?? "";
  if (workspaceId === "") return OFFICE_ENGINE_NO_MACHINE;
  const answer = await context.office.engine(workspaceId);
  if (answer.__typename === "OfficeFailure") return officeFailure(answer.code, answer.message);
  return answer;
};

/**
 * The office fields, split by the root that owns each.
 *
 * @remarks
 * The two roots need different subsets, and one value keeps the names and their resolvers in one
 * place: the Query takes {@link OfficeFieldSets.query}, and the Mutation module builds its one
 * field from {@link OfficeFieldSets.mutation}.
 */
export interface OfficeFieldSets {
  readonly query: GraphQLFieldConfigMap<undefined, GraphQLContext>;
  readonly mutation: GraphQLFieldConfigMap<undefined, GraphQLContext>;
}

/**
 * The office fields of the Query and Mutation roots (0237 §6).
 *
 * @returns The three field configs, by name; the two roots take the ones they own.
 *
 * @remarks
 * `documentPreview` and `officeEngine` are reads; `requestDocumentPreview` writes a row and arms
 * the alarm, and is the only one of the three that changes anything.
 */
export function officeFields(): OfficeFieldSets {
  return {
    query: {
      documentPreview: {
        type: new GraphQLNonNull(DocumentPreviewResultType),
        args: {
          path: { type: new GraphQLNonNull(GraphQLString) },
          workspaceId: { type: GraphQLString },
        },
        resolve: documentPreviewResolver,
      },
      officeEngine: {
        type: new GraphQLNonNull(OfficeEngineType),
        args: { workspaceId: { type: GraphQLString } },
        resolve: officeEngineResolver,
      },
    },
    mutation: {
      requestDocumentPreview: {
        type: new GraphQLNonNull(DocumentPreviewResultType),
        args: {
          path: { type: new GraphQLNonNull(GraphQLString) },
          workspaceId: { type: GraphQLString },
        },
        resolve: requestDocumentPreviewResolver,
      },
    },
  };
}
