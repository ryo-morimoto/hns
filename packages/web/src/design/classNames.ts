/** Join conditional class names. One place for the primitive class merge order. */
export function classNames(...values: readonly (string | false | undefined)[]): string {
  return values.filter((value) => value !== false && value !== undefined).join(" ");
}
