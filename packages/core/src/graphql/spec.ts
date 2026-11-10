// A typed description of the GraphQL types. The table is checked against the model at
// compile time: every key is required, and each field's GraphQL shape is derived from
// the TypeScript type, so a mismatch fails to build.
import type { Brand } from "../types.ts";
import type { EntityRegistry, EnumRegistry } from "./registry.ts";

export type GqlScalarName = "ID" | "String" | "Int" | "Float" | "Boolean";

interface ScalarRef<T extends GqlScalarName> {
  readonly kind: "scalar";
  readonly type: T;
}

interface EnumRef<N extends string> {
  readonly kind: "enum";
  readonly typeName: N;
}

interface ObjectRef<N extends string> {
  readonly kind: "object";
  readonly typeName: N;
}

/** Entity names whose model type is assignable to V, and V to it. */
type ObjectNameFor<V> = {
  [N in keyof EntityRegistry]-?: [EntityRegistry[N]] extends [V]
    ? [V] extends [EntityRegistry[N]]
      ? N
      : never
    : never;
}[keyof EntityRegistry];

/** Enum names whose union equals V. */
type EnumNameFor<V> = {
  [N in keyof EnumRegistry]-?: [EnumRegistry[N]] extends [V]
    ? [V] extends [EnumRegistry[N]]
      ? N
      : never
    : never;
}[keyof EnumRegistry];

type NonNullField<V> = [V] extends [Brand<string, string>]
  ? ScalarRef<"ID">
  : [V] extends [boolean]
    ? ScalarRef<"Boolean">
    : [V] extends [number]
      ? ScalarRef<"Int" | "Float">
      : [V] extends [string]
        ? [string] extends [V]
          ? ScalarRef<"String" | "ID">
          : [EnumNameFor<V>] extends [never]
            ? ScalarRef<"String" | "ID">
            : EnumRef<EnumNameFor<V>>
        : [V] extends [object]
          ? ObjectRef<ObjectNameFor<V>>
          : never;

type IsNullable<V> = null extends V ? true : undefined extends V ? true : false;

/** The GraphQL shape of one model field. Nullability is derived, never guessed. */
export type FieldFor<V> =
  IsNullable<V> extends true
    ? NonNullField<NonNullable<V>> & { readonly nonNull: false }
    : NonNullField<V> & { readonly nonNull: true };

export type FieldEntry<V> = { readonly name: string } & FieldFor<V>;

/** The runtime form of a field entry, after the type-level check has passed. */
type SpecField =
  | {
      readonly name: string;
      readonly kind: "scalar";
      readonly type: GqlScalarName;
      readonly nonNull: boolean;
    }
  | {
      readonly name: string;
      readonly kind: "enum";
      readonly typeName: string;
      readonly nonNull: boolean;
    }
  | {
      readonly name: string;
      readonly kind: "object";
      readonly typeName: string;
      readonly nonNull: boolean;
    };

export type FieldTable<T> = { readonly [K in keyof T]-?: FieldEntry<T[K]> };

export interface RegisteredField {
  readonly name: string;
  readonly kind: "scalar" | "enum" | "object";
  readonly typeName: string;
  readonly nonNull: boolean;
}

export interface EntityDef {
  readonly name: string;
  readonly fields: readonly RegisteredField[];
}

export interface EnumDef {
  readonly name: string;
  readonly values: readonly { readonly name: string; readonly value: string }[];
}

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/u;
const BOOLEAN_NAME = /^(?:is|has)[A-Z0-9]/u;

function assertName(kind: string, name: string): void {
  if (!NAME.test(name)) throw new Error(kind + " is not a GraphQL name: " + name);
  if (name.startsWith("__")) throw new Error(kind + " uses a reserved name: " + name);
}

/** `todo` -> `TODO`, `conversationBlocked` -> `CONVERSATION_BLOCKED`. Deterministic. */
export function publicEnumName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toUpperCase();
}

export function enumOf<N extends keyof EnumRegistry>(
  name: N,
  values: readonly EnumRegistry[N][],
): EnumDef {
  assertName("enum", name);
  const seen = new Set<string>();
  const mapped = values.map((value) => {
    const publicName = publicEnumName(String(value));
    if (publicName === "TRUE" || publicName === "FALSE" || publicName === "NULL") {
      throw new Error("enum value is reserved in GraphQL: " + String(value));
    }
    assertName("enum value", publicName);
    if (seen.has(publicName)) throw new Error("enum value collides after mapping: " + publicName);
    seen.add(publicName);
    return { name: publicName, value: String(value) };
  });
  return { name, values: mapped };
}

function toRegisteredField(entry: SpecField): RegisteredField {
  assertName("field", entry.name);
  if (entry.kind === "scalar") {
    return { name: entry.name, kind: "scalar", typeName: entry.type, nonNull: entry.nonNull };
  }
  return { name: entry.name, kind: entry.kind, typeName: entry.typeName, nonNull: entry.nonNull };
}

export function defineEntity<T>(spec: {
  readonly name: string;
  readonly fields: FieldTable<T>;
}): EntityDef {
  assertName("type", spec.name);
  // SAFETY: Object.entries preserves the mapped table's entries, which FieldTable already
  // constrained at compile time; the cast only moves them to their runtime form.
  const entries = Object.entries(spec.fields) as ReadonlyArray<readonly [string, SpecField]>;
  const fields = entries.map(([, entry]) => toRegisteredField(entry));
  const names = new Set<string>();
  for (const field of fields) {
    if (names.has(field.name))
      throw new Error("duplicate field on " + spec.name + ": " + field.name);
    names.add(field.name);
    if (field.kind === "scalar" && field.typeName === "Boolean" && !BOOLEAN_NAME.test(field.name)) {
      throw new Error("boolean field needs an is/has prefix: " + spec.name + "." + field.name);
    }
  }
  return { name: spec.name, fields };
}
