/** Fail a package build when test-only code survives in dist/. */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

const TEST_CALLS = new Set([
  "test",
  "expect",
  "it",
  "describe",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
]);

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && /\.[cm]?js$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function scan(path: string): Finding[] {
  const text = readFileSync(path, "utf8");
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === "vitest"
    ) {
      findings.push({ file: path, line: lineOf(source, node), what: "import.meta.vitest" });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      TEST_CALLS.has(node.expression.text)
    ) {
      findings.push({ file: path, line: lineOf(source, node), what: node.expression.text + "()" });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      TEST_CALLS.has(node.expression.expression.text)
    ) {
      findings.push({
        file: path,
        line: lineOf(source, node),
        what: node.expression.expression.text + ".*()",
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** Test-only code that a production build must not carry. Throws when dist/ is missing. */
export function findInSourceTestCode(directory: string): Finding[] {
  return walk(directory).flatMap(scan);
}

const isMain = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url;
};

if (isMain()) {
  const directory = process.argv[2] ?? "dist";
  try {
    const findings = findInSourceTestCode(directory);
    if (findings.length === 0) process.exitCode = 0;
    else {
      for (const finding of findings) {
        console.error("dist-check: " + finding.file + ":" + finding.line + " has " + finding.what);
      }
      console.error("dist-check: test-only code survived in " + directory);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      "dist-check: " + (error instanceof Error ? error.message : "cannot read " + directory),
    );
    process.exitCode = 1;
  }
}
