// A typed description of the GraphQL types. The table is checked against the model at
// compile time: every key is required, and each field's GraphQL shape is derived from
// the TypeScript type, so a mismatch fails to build.
import type { Brand } from "../types.ts";
import type { EntityRegistry, EnumRegistry } from "./registry.ts";

/** The GraphQL built-in scalar names the model projects to. */
export type GqlScalarName = "ID" | "String" | "Int" | "Float" | "Boolean";

/** A reference to a built-in GraphQL scalar. */
interface ScalarRef<T extends GqlScalarName> {
  readonly kind: "scalar";
  readonly type: T;
}

/** A reference to a registered GraphQL enum. */
interface EnumRef<N extends string> {
  readonly kind: "enum";
  readonly typeName: N;
}

/** A reference to a registered GraphQL object. */
interface ObjectRef<N extends string> {
  readonly kind: "object";
  readonly typeName: N;
}

/**
 * Entity names whose model type is assignable to V, and V to it.
 *
 * @internal
 */
type ObjectNameFor<V> = {
  [N in keyof EntityRegistry]-?: [EntityRegistry[N]] extends [V]
    ? [V] extends [EntityRegistry[N]]
      ? N
      : never
    : never;
}[keyof EntityRegistry];

/**
 * Enum names whose union equals V.
 *
 * @internal
 */
type EnumNameFor<V> = {
  [N in keyof EnumRegistry]-?: [EnumRegistry[N]] extends [V]
    ? [V] extends [EnumRegistry[N]]
      ? N
      : never
    : never;
}[keyof EnumRegistry];

/**
 * Map a non-null model value to its GraphQL shape.
 *
 * @remarks
 * Branded strings become `ID`; strings that exactly match a registered enum become that enum;
 * other strings become `String` or `ID`; booleans become `Boolean`; numbers become `Int` or
 * `Float`; registered model objects become their object type.
 */
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

/** Whether the model type admits null or undefined. */
type IsNullable<V> = null extends V ? true : undefined extends V ? true : false;

/**
 * The GraphQL shape of one model field. Nullability is derived, never guessed.
 *
 * @remarks
 * `null` and `undefined` both make the field nullable; everything else becomes non-null. The
 * field table in `entities.ts` is checked against the model at compile time, so a model change
 * that the GraphQL shape does not follow fails to build.
 */
export type FieldFor<V> =
  IsNullable<V> extends true
    ? NonNullField<NonNullable<V>> & { readonly nonNull: false }
    : NonNullField<V> & { readonly nonNull: true };

/** A model field and the GraphQL shape derived for it. */
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

/**
 * The compile-time field table for a model type.
 *
 * @remarks
 * Every key is required and every value is checked against the model's type, so a missing or
 * mismatched field fails to compile. `defineEntity` turns the table into its runtime form.
 */
export type FieldTable<T> = { readonly [K in keyof T]-?: FieldEntry<T[K]> };

/** The runtime form of a field, after the type-level check has passed. */
export interface RegisteredField {
  /** The GraphQL field name on the wire. */
  readonly name: string;
  /** What `typeName` names: a scalar, an enum, or an object. */
  readonly kind: "scalar" | "enum" | "object";
  /** Scalar name, enum name, or object type name, matching `kind`. */
  readonly typeName: string;
  /** False when the field may be null. */
  readonly nonNull: boolean;
}

/** A GraphQL object type contributed by the model. */
export interface EntityDef {
  readonly name: string;
  /** Fields in spec order; `buildSdl` sorts them by name. */
  readonly fields: readonly RegisteredField[];
}

/** A GraphQL enum type contributed by the model. */
export interface EnumDef {
  readonly name: string;
  /** GraphQL value name mapped to the model string it represents. */
  readonly values: readonly { readonly name: string; readonly value: string }[];
}

/** The GraphQL name grammar: `[_A-Za-z][_0-9A-Za-z]*`. */
const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/u;
/** Boolean fields are exposed with an `is`/`has` prefix, as in `isArchived`. */
const BOOLEAN_NAME = /^(?:is|has)[A-Z0-9]/u;

/**
 * Throw unless `name` is a legal GraphQL name.
 *
 * @internal
 * @param kind - What is being named, for the error message: `type`, `field`, `enum`, ...
 * @param name - The candidate GraphQL name.
 * @throws Error when the name has characters outside `[_A-Za-z0-9]`, does not start with a
 * letter or `_`, or uses the reserved `__` prefix.
 */
function assertName(kind: string, name: string): void {
  if (!NAME.test(name)) throw new Error(kind + " is not a GraphQL name: " + name);
  if (name.startsWith("__")) throw new Error(kind + " uses a reserved name: " + name);
}

if (import.meta.vitest) {
  const { expect, test } = import.meta.vitest;
  test("a legal GraphQL name is accepted", () => {
    expect(() => assertName("type", "Valid_1")).not.toThrow();
  });
  test("a reserved or malformed GraphQL name is refused", () => {
    expect(() => assertName("type", "__Reserved")).toThrow();
    expect(() => assertName("type", "1Invalid")).toThrow();
  });
}

/**
 * `todo` -> `TODO`, `conversationBlocked` -> `CONVERSATION_BLOCKED`. Deterministic.
 *
 * @param value - The model's string value.
 * @returns The GraphQL enum value name.
 *
 * @remarks
 * The mapping is not a validator: an input whose first character is a digit still maps to a name
 * starting with a digit. `enumOf` checks the result and refuses malformed, reserved, or colliding
 * names.
 */
export function publicEnumName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toUpperCase();
}

/**
 * Define a GraphQL enum from the model's closed vocabulary.
 *
 * @typeParam N - The registered enum name; `values` must be its union.
 * @param name - GraphQL enum name, checked against the GraphQL grammar.
 * @param values - Model values in declaration order; the order is preserved.
 * @returns The enum with GraphQL names mapped by `publicEnumName` and model values unchanged.
 * @throws Error when `name` is not a GraphQL name, a mapped value is `TRUE`/`FALSE`/`NULL`
 * or not a GraphQL name, or two values map to the same name.
 *
 * @remarks
 * Uniqueness is checked after mapping, so distinct model values that normalize to one name are
 * refused rather than silently collapsed.
 */
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

/**
 * Move a field entry from its compile-time shape to its runtime shape.
 *
 * @internal
 */
function toRegisteredField(entry: SpecField): RegisteredField {
  assertName("field", entry.name);
  if (entry.kind === "scalar") {
    return { name: entry.name, kind: "scalar", typeName: entry.type, nonNull: entry.nonNull };
  }
  return { name: entry.name, kind: entry.kind, typeName: entry.typeName, nonNull: entry.nonNull };
}

/**
 * Define a GraphQL object type from a compile-time field table.
 *
 * @typeParam T - The model type; the table must cover every field.
 * @param spec - GraphQL type name and the field table.
 * @returns The runtime entity definition used by `buildSdl` / `buildSchema`.
 * @throws Error when the type or a field name is not a GraphQL name, a field name repeats, or a
 * Boolean field lacks an `is`/`has` prefix.
 *
 * @remarks
 * The field table is checked against `T` at compile time; this function checks the runtime names
 * only. Same-named fields are rejected because GraphQL would silently merge them.
 */
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
