import * as v from "valibot";

/**
 * A project id as it appears in a URL or a WebSocket query.
 *
 * @remarks
 * The store creates `default` or a UUID, so the alphabet is deliberately narrow: a URL part
 * cannot smuggle a path separator, a space, or a NUL into a Durable Object name. This is the
 * parse for a raw id, not the model's permissive `ProjectIdSchema`, which also carries ids
 * read from storage.
 */
export const ProjectParamSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(128),
  v.regex(/^[\w-]+$/u),
);
