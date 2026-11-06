import { ProjectIdSchema, type ProjectId } from "@hns/core";
import * as v from "valibot";

/** URL ids are external input; an id that fails the schema is simply absent. */
export function projectIdFrom(value: string): ProjectId | null {
  const parsed = v.safeParse(ProjectIdSchema, value);
  return parsed.success ? parsed.output : null;
}
