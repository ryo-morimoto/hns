import { Fragment, type ReactElement, type ReactNode } from "react";

/**
 * One span of model text, as the screen is allowed to draw it.
 *
 * @remarks
 * Plain text, one code span, one link, or one fenced block. Nothing else exists: there is no
 * bold, no heading, no list, and no raw HTML. That is the whole of the formatting this screen
 * offers, and it is the whole of what it can be made to draw.
 */
type Segment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string }
  | { readonly kind: "block"; readonly text: string; readonly language: string };

const FENCE = /^```([^\n`]*)$/u;
const INLINE = /(`[^`\n]+`)|(https?:\/\/[^\s<>()"'`]+)/u;

/**
 * The URL a link may point at, or null.
 *
 * @param text - A token that starts with `http`.
 *
 * @remarks
 * Only `http:` and `https:` are links. Anything else that looks like a scheme is text: a
 * `javascript:` or `data:` href is never built, and the token is shown as written.
 */
export function safeHref(text: string): string | null {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Cut one line of text into inline segments. */
function inlineSegments(line: string): readonly Segment[] {
  const segments: Segment[] = [];
  let rest = line;
  for (;;) {
    const match = INLINE.exec(rest);
    if (match === null) {
      if (rest !== "") segments.push({ kind: "text", text: rest });
      return segments;
    }
    const index = match.index;
    if (index > 0) segments.push({ kind: "text", text: rest.slice(0, index) });
    const token = match[0];
    if (token.startsWith("`")) {
      segments.push({ kind: "code", text: token.slice(1, -1) });
    } else {
      // A URL at the end of a sentence keeps its full stop out of the link.
      const trimmed = token.replace(/[.,;:!?]+$/u, "");
      const href = safeHref(trimmed);
      if (href === null) {
        segments.push({ kind: "text", text: token });
      } else {
        segments.push({ kind: "link", text: trimmed, href });
        if (trimmed.length < token.length) {
          segments.push({ kind: "text", text: token.slice(trimmed.length) });
        }
      }
    }
    rest = rest.slice(index + token.length);
  }
}

/**
 * Cut model text into the segments the screen draws.
 *
 * @param text - The entry's text, as the server carried it.
 * @returns Text lines, fenced blocks, and the inline segments of each line.
 *
 * @remarks
 * A fence runs from a line starting with three backticks to the next fence line or the end of
 * the text, so an unterminated fence does not swallow the rest of the turn into a link. Nothing
 * is HTML-parsed: the segments are strings, and React escapes them.
 */
export function segmentsOf(text: string): readonly Segment[] {
  const lines = text.split("\n");
  const segments: Segment[] = [];
  let inBlock = false;
  let language = "";
  let block: string[] = [];
  for (const line of lines) {
    if (!inBlock) {
      const fence = FENCE.exec(line);
      if (fence !== null) {
        inBlock = true;
        language = (fence[1] ?? "").trim();
        block = [];
        continue;
      }
      segments.push(...inlineSegments(line));
      segments.push({ kind: "text", text: "\n" });
      continue;
    }
    if (line.startsWith("```")) {
      segments.push({ kind: "block", text: block.join("\n"), language });
      inBlock = false;
      segments.push({ kind: "text", text: "\n" });
      continue;
    }
    block.push(line);
  }
  if (inBlock) segments.push({ kind: "block", text: block.join("\n"), language });
  // A trailing newline would render as an empty line the text did not have.
  const last = segments.at(-1);
  if (last !== undefined && last.kind === "text" && last.text === "\n") segments.pop();
  return segments;
}

/**
 * Draw model text as React children.
 *
 * @param props.text - The text to draw.
 * @returns Text, `code`, `pre`, and `a` elements; never markup.
 *
 * @remarks
 * The element set is closed and each one is built from strings, so a model cannot reach the DOM
 * as markup. Links open in a new tab with `rel="noreferrer noopener"`, because the destination is
 * written by a model and must not keep a handle on this page.
 */
export function RichText({ text }: { readonly text: string }): ReactElement {
  const segments = segmentsOf(text);
  const nodes: ReactNode[] = segments.map((segment, index) => {
    switch (segment.kind) {
      case "text":
        return <Fragment key={index}>{segment.text}</Fragment>;
      case "code":
        return (
          <code key={index} className="hns-message__code">
            {segment.text}
          </code>
        );
      case "link":
        return (
          <a
            key={index}
            className="hns-message__link"
            href={segment.href}
            target="_blank"
            rel="noreferrer noopener"
          >
            {segment.text}
          </a>
        );
      case "block":
        return (
          <pre key={index} className="hns-message__block" data-language={segment.language}>
            <code>{segment.text}</code>
          </pre>
        );
      default: {
        const unhandled: never = segment;
        throw new Error("unhandled segment: " + JSON.stringify(unhandled));
      }
    }
  });
  return <>{nodes}</>;
}
