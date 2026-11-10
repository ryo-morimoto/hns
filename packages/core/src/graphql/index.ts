// The GraphQL contract, generated from the model. Kept out of the root entry so the
// browser bundle never pulls in graphql-js.
export { buildSchema, buildSdl, buildTypes } from "./schema.ts";
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
