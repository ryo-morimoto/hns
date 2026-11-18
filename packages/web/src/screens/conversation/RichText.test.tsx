import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { RichText, safeHref, segmentsOf } from "./RichText.tsx";

// Catches: a model writing HTML and the screen drawing it, which would reach exec (D094).
test("markup in model text stays text", () => {
  const { container } = render(
    <RichText text={'<b>bold</b><img src=x onerror="x()"><script>x()</script>'} />,
  );
  expect(container.querySelector("b")).toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toBe('<b>bold</b><img src=x onerror="x()"><script>x()</script>');
});

// Catches: a link built from anything that looks like a scheme, so a `javascript:` URL becomes
// something the browser will run when it is followed.
test("only http and https URLs become links", () => {
  expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
  // The URL constructor normalizes an origin, so the href is the browser's spelling of it.
  expect(safeHref("http://example.com")).toBe("http://example.com/");
  expect(safeHref("javascript:alert(1)")).toBeNull();
  expect(safeHref("data:text/html,<script>")).toBeNull();
  expect(safeHref("ftp://example.com")).toBeNull();
  expect(safeHref("not a url")).toBeNull();

  const { container } = render(<RichText text="see javascript:alert(1) now" />);
  expect(container.querySelector("a")).toBeNull();
});

// Catches: a URL followed by a full stop swallowing the punctuation into the link.
test("a URL at the end of a sentence keeps its punctuation out", () => {
  const { container } = render(<RichText text={"see https://example.com/a. done"} />);
  const link = container.querySelector("a");
  expect(link?.getAttribute("href")).toBe("https://example.com/a");
  expect(link?.getAttribute("target")).toBe("_blank");
  expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
  expect(container.textContent).toContain("see https://example.com/a. done");
});

// Catches: an inline code span drawn as plain text, or a code span swallowing the rest of a line.
test("inline code is a code element and stops at its backtick", () => {
  const { container } = render(<RichText text="run `pnpm test` then stop" />);
  expect(container.querySelector("code")?.textContent).toBe("pnpm test");
  expect(container.textContent).toBe("run pnpm test then stop");
});

// Catches: a fenced block drawn inline, or an unterminated fence swallowing the rest of the turn.
test("a fenced block is a pre element, and an open fence ends at the text's end", () => {
  const closed = render(<RichText text={"before\n```ts\nconst a = 1;\n```\nafter"} />);
  const pre = closed.container.querySelector("pre");
  expect(pre?.textContent).toBe("const a = 1;");
  expect(pre?.getAttribute("data-language")).toBe("ts");
  expect(closed.container.textContent).toContain("after");

  const open = render(<RichText text={"x\n```\nhttps://inside.example.com"} />);
  expect(open.container.querySelector("pre")?.textContent).toBe("https://inside.example.com");
  expect(open.container.querySelector("a")).toBeNull();
});

// Catches: a trailing newline drawn as an empty line the text did not have, and segments that
// do not round-trip to the text they came from.
test("segments keep the text they were cut from", () => {
  const text = "one\n`code`\n```\nblock\n```\ntail";
  const segments = segmentsOf(text);
  expect(segments.at(-1)).toStrictEqual({ kind: "text", text: "tail" });
  const { container } = render(<RichText text={text} />);
  expect(container.textContent?.replace(/\n/gu, " ")).toContain("block");
  expect(segmentsOf("plain\n")[0]).toStrictEqual({ kind: "text", text: "plain" });
});
