/**
 * The GraphQL contract, generated from the model.
 *
 * @remarks
 * Kept out of the root entry so the browser bundle never pulls in graphql-js. The SDL is
 * generated from the entity specs; do not hand-edit it.
 */
export { buildSchema, buildSdl, buildTypes } from "./schema.ts";
export { fromGlobalId, toGlobalId } from "./global-id.ts";
export type { GlobalId, GlobalIdResult } from "./global-id.ts";
export type { QueryRootFactory } from "./schema.ts";
export {
  ConversationEntity,
  ENTITIES,
  ENUMS,
  EXCLUDED,
  ProjectEntity,
  TaskEntity,
  TaskStatusEnum,
} from "./entities.ts";
export { defineEntity, enumOf, publicEnumName } from "./spec.ts";
export type {
  EntityDef,
  EnumDef,
  FieldEntry,
  FieldFor,
  FieldTable,
  GqlScalarName,
  RegisteredField,
} from "./spec.ts";
