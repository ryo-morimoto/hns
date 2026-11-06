# AGENTS.md

## Project Structure

hns is an npm-workspaces monorepo: a self-hosted platform for operating AI agents on several machines from one UI.

### Key Directories

- `packages/` — product code, one package per capability
  - `packages/core` — the model (`src/types.ts`), valibot boundary schemas (`src/schemas.ts`), workflow state transitions (`src/workflow.ts`)
  - `packages/store` — SQLite row schemas and `parse*` functions that produce the public model
  - planned: `workspace`, `agent`, `server`, `web` (see [docs/packages.md](docs/packages.md))
- `work/` — remaining work and history
  - `work/poc/` — the integrated PoC app (plain JS). **Not product code.** Do not add features here
  - `work/BOARD.md`, `work/issues/` — the backlog and per-issue notes
- `docs/` — flat specs: architecture decisions, auth, safety, observability, packages, type review
- `scripts/` — `check.sh`, `with-node.sh`, `install-hooks.sh`
- `.githooks/` — `pre-commit` runs the full check

### Architecture Notes

- Target package graph: `server → agent / store / workspace → core`; `web → core`. Never the other way
- Conversation runtime is pi-durable 1.5.0 (external, pinned). We compose it, not fork it
- Persistence is SQLite through `node:sqlite`; there is no ORM
- Types are the source of truth; valibot schemas are typed against them (`v.GenericSchema<unknown, T>`)
- Product code is TypeScript strict. The PoC is JavaScript and stays that way
- Workflow / automation state transitions live only in `packages/core/src/workflow.ts`

## Quick Start

```bash
scripts/with-node.sh npm install
scripts/with-node.sh npm run check
```

Read [CODING_STANDARDS.md](CODING_STANDARDS.md) before writing code. It is the only place coding rules live.

Run the PoC app (optional, for manual checks):

```bash
scripts/with-node.sh node work/poc/app/serve.mjs /path/to/workspace
# PROVIDER=ollama|opencode|faux  MODEL_ID=...  STATE_DIR=...  (prints the URL with a token)
```

## Build Commands

| Command | What it does |
| --- | --- |
| `scripts/with-node.sh npm run check` | oxlint → oxfmt --check → tsc → test → build (all workspaces) |
| `scripts/with-node.sh npm test -w @hns/store` | tests for one package |
| `scripts/with-node.sh npm run build -w @hns/store` | `dist/` for one package |
| `scripts/with-node.sh npm run lint` | oxlint only |
| `scripts/with-node.sh npm run fmt` | oxfmt, in place |

`npm run check` is the gate. It also runs from the pre-commit hook (install once with `scripts/install-hooks.sh`).
Building is not proof of correctness; types and tests are.

## Development

### Coding Patterns and Best Practices

- All rules: [CODING_STANDARDS.md](CODING_STANDARDS.md). Do not restate them here
- Parse rows in `store` with `parse*` (valibot). Never export a row type or a storage shape
- A new event name, task status, or workflow status goes into the const array in `packages/core/src/types.ts`; the union derives from it
- Use `ErrorCode` for expected API failures. Do not add new string error fields
- Use `import type` for types and a separate value import for values
- Public package surface is `exports` only; do not deep-import another package's `src/`

### Package Structure

Each package follows the pi layout:

```
packages/store/
├── package.json       # name, exports with the “source” condition, files, scripts
├── tsconfig.json      # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, customConditions: [“source”]
├── tsconfig.build.json
├── src/
├── test/              # node --test, *.test.ts
├── README.md
└── CHANGELOG.md
```

To add a package: create the directory above, depend on `@hns/core` at the **same version**, run `npm install`, and add tests and a README. Update [docs/packages.md](docs/packages.md) and add a decision if the boundary changes.

## Testing

### Writing Tests - Required Practices

- **Do not mock persistence.** Use real SQLite (`:memory:` or a temp file); the schema and constraints are part of what you test
- **A test names the regression it catches.** If it cannot be said in one line, do not add it. Write `// Catches: <bug>` above the case
- Cover failure paths: invalid input, illegal transitions, conflicts, unknown enum values
- Test behavior, not implementation: no assertions on internal helper names, log wording, or CSS
- One behavior per test. A test that passes when the logic is broken is not a test
- Package-to-package imports in tests use `node --conditions=source` (already set in `@hns/store`'s test script)

### How to run tests

```bash
scripts/with-node.sh npm test -w @hns/core
scripts/with-node.sh npm test -w @hns/store
scripts/with-node.sh npm run check          # everything
```

### Test Structure

Tests live in `packages/<pkg>/test/*.test.ts` and run with `node --test` plus type stripping. There is no shared fixture package yet: each file creates its own temp or in-memory SQLite database and closes it.

Browser tests (PoC only) look for Chromium; if it is missing they skip. Set `HNS_CHROME` to override the binary.

## Linting & Formatting

- **oxlint** with the vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules (`tools/oxlint/anti-slop/`). Read a rule before disabling it; do not edit the vendored copy without recording it in `UPSTREAM.md`
- **oxfmt** owns whitespace. `require-readable-spacing` is disabled because the two disagree
- `npm run lint` / `npm run fmt`; the pre-commit hook runs both through `npm run check`
- Type checks run per workspace (`tsc --noEmit`)

## Commit Guidelines

- One purpose per commit. Do not mix formatting or unrelated refactors
- Message: `area: summary` (for example `store: parse rows with valibot`)
- **Do not push.** Commits stay local until the user asks

## Additional Resources

Read on demand — not every session:

| When | What |
| --- | --- |
| Requirements and scope | `README.md`, `ARCH.md` |
| Package boundaries and where types live | `docs/packages.md` |
| Why a decision was made | `docs/decisions.md` (append-only) |
| Stack, tooling, AI-slop gates | `docs/engineering.md` |
| How to review a type | `docs/type-review.md` |
| Comparison with the golden examples | `docs/typescript.md` |
| Current backlog | `work/BOARD.md`, `work/issues/` |
