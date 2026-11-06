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
nix develop
npm install
npm run check
```

Node 26 is pinned by `flake.nix`. Run anything that needs `node`/`npm` inside `nix develop` (or prefix it with `nix develop --command`).

`npm run check` is the gate: oxlint → oxfmt --check → tsrs → test → build. It also runs from the pre-commit hook after `git config core.hooksPath .githooks` (one line per clone; commit inside `nix develop`).
Building is not proof of correctness; types and tests are.

## Build Commands

| Command | What it does |
| --- | --- |
| `npm run check` | everything below, in order |
| `npm test -w @hns/store` | tests for one package |
| `npm run build -w @hns/store` | `dist/` for one package |
| `npm run lint` | oxlint only |
| `npm run fmt` | oxfmt, in place |

Run these inside `nix develop`.

## Development

### Coding Patterns and Best Practices

Each rule's condition and source links are in [docs/design.md](docs/design.md).

**Types**

- **The model is the source of truth.** `packages/core/src/types.ts` comes first; valibot schemas are written to fit it (`v.GenericSchema<unknown, T>`). A mismatch must fail to compile. Do not derive types from schemas
- **No `any`.** `any` switches the checker off for every value that flows through it. Take `unknown` and parse it. If a third-party type is genuinely `any`, cast once at the edge into a named type and keep it out of public signatures
- **Assertions need evidence.** `as` does nothing at runtime. Never assert on untrusted data. Where an assertion is unavoidable, put `// SAFETY: <invariant>` immediately before it (enforced by anti-slop)
- **Optional, `null`, and absent are different.** `?:` means the key is missing, `null` means the value is missing. `exactOptionalPropertyTypes` is on; write `?: T | undefined`
- **Brands are for confusable ids.** Brand a value only when the same primitive crosses scopes and mixing it up would break something. There is no fixed list; when adding one, name the mix-up it prevents (current examples: `ProjectId`, `ConversationId`)
- **Unions are closed; `switch` is exhaustive.** Status and event vocabularies are `const` arrays with derived unions. Every `switch` lists every member and ends in `never`. Do not use `default` to absorb the rest

**Validation**

- **`unknown` stays `unknown` until parsed.** HTTP bodies, DB rows, environment variables, and JSON are external. Parse once at the boundary; trust the type inside. `satisfies` is not runtime validation
- **Storage shapes never leave their package.** `archived: 0 | 1`, JSON strings, and sequence numbers stay inside `store`. Return the public model after `parse*`
- **Invalid stored data fails loudly.** Unknown enum values and missing fields throw (valibot's `ValiError`). Never fall back to a default; a corrupt row must surface

**Errors**

- **Expected failures are typed.** API failures use the `ErrorCode` union (`invalid_request`, `unauthorized`, `not_found`, `conflict`, `rate_limited`, …). Do not add new string `error` fields; make it something the caller can branch on
- **Throw `Error`, not values.** A thrown string or object loses the stack and every `instanceof` check downstream. Unexpected failures are `Error` subclasses
- **Do not swallow failures.** No empty `catch`. Await the promise, or write `void` with a reason. Catch only the kind you expect and let the rest through

**Safety**

- **Secrets never enter the repo or logs.** Keys live in `~/.config/hns/`. Event logs keep the path and status, never bodies, headers, or tokens
- **Authorization is checked at the boundary.** Never trust UI state or an id sent by the client. Mutations check the caller and the owner at the boundary
- **Never trust input for paths or commands.** Normalize paths and confirm they stay under the workspace root. Run commands through the sandbox (bubblewrap); if the sandbox is unavailable, do not offer exec
- **Fail closed.** Authentication, sandbox availability, and root identity are verified or refused. A check that cannot run is a denial

**Code**

- **Comments explain why, not what.** Two or three lines, hard ceiling five. Longer reasoning goes to a docstring, README, or decision, and the comment points there. Do not restate the same fact in several places
- **Reuse existing guards and helpers.** Reimplementation is the most common AI-authored defect. Look in `packages/core` and the package you are editing first
- **New abstractions need two call sites.** Build for what exists, not for a guessed future
- **Match the surrounding code.** Naming, structure, and comment density come from the adjacent file. The type, validation, and safety rules above win over local style
- **Generated files are not hand-edited.** Keep headers and regeneration commands intact

### Package Structure

Each package follows the pi layout:

```
packages/store/
├── package.json       # name, exports with the "source" condition, files, scripts
├── tsconfig.json      # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, customConditions: ["source"]
├── tsconfig.build.json
├── src/
├── test/              # vitest, *.test.ts
├── README.md
└── CHANGELOG.md
```

- **Dependencies are one-way.** Allowed edges and where types live are in [docs/packages.md](docs/packages.md)
- **The public surface is `exports`.** Never deep-import another package's `src/`; internal types stay internal
- **A new dependency needs a recorded reason.** One line in a decision; exact pin; if the standard library can do it, use that
- **Static imports over dynamic.** Use `import()` only for a cycle, code splitting, or genuinely conditional loading

To add a package: create the directory above, depend on `@hns/core` at the **same version**, run `npm install`, and add tests and a README. Update [docs/packages.md](docs/packages.md) and add a decision if the boundary changes.

### Running the PoC App

```bash
work/poc/install.sh   # once, inside the dev shell; installs the PoC dependencies
node work/poc/app/serve.mjs /path/to/workspace
# PROVIDER=ollama|opencode|faux  MODEL_ID=...  STATE_DIR=...  (prints the URL with a token)
```

The PoC is for manual checks only. New product work goes into `packages/`.

## Testing

### Writing Tests - Required Practices

- **Do not mock persistence.** Use real SQLite (`:memory:` or a temp file); the schema and constraints are part of what you test
- **A test names the regression it catches.** If it cannot be said in one line, do not add it. Write `// Catches: <bug>` above the case
- Cover failure paths: invalid input, illegal transitions, conflicts, unknown enum values
- Test behavior, not implementation: no assertions on internal helper names, log wording, or CSS. One behavior per test; a test that passes when the logic is broken is not a test
- **Make sure the test runs.** Vitest 5 (`vitest run`); assertions use `node:assert/strict`. The full discipline is in [docs/testing.md](docs/testing.md)

### How to run tests

```bash
npm test -w @hns/core
npm test -w @hns/store
npm run check          # everything
```

Inside `nix develop`. Tests use Vitest; the layers and rules are in [docs/testing.md](docs/testing.md).

### Test Structure

Tests live in `packages/<pkg>/test/*.test.ts`. There is no shared fixture package yet: each file creates its own in-memory or temporary SQLite database and closes it.

Browser tests (PoC only) look for Chromium; if it is missing they skip. Set `HNS_CHROME` to override the binary.

## Review

- **The goal is a change that safely fulfills its contract, not a perfect diff.** Judge behavior over appearance, evidence over suspicion, this change's regressions over pre-existing problems, and signal over volume
- **Independent review after implementation, before commit.** Your own reading is not review. A change in scope is done when `npm run check` passes *and* an agent that wrote none of the code returns `PASS`. The procedure is [docs/review.md](docs/review.md); read only the invariant files the change touches
- **Only regressions block.** What this change made worse is blocking; what pre-dates it becomes an issue, not a blocker (definition: [docs/review.md](docs/review.md)). Ask for the smallest correction that restores the contract
- **A fix is re-reviewed.** The fix diff is where new defects enter (hns shipped two in one round). The reviewer checks the fix against the boundary schemas and docs it touched
- **Record it.** Verdict, reviewer, HEAD, and blocking findings go in the issue's `## Result`. No record, no `done`

## Linting & Formatting

- **oxlint** with the vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules (`tools/oxlint/anti-slop/`). Read a rule before disabling it; do not edit the vendored copy without recording it in `UPSTREAM.md`
- **oxfmt** owns whitespace. `require-readable-spacing` is disabled because the two disagree
- `npm run lint` / `npm run fmt`; the pre-commit hook runs both through `npm run check`
- Type checks run per workspace (`tsrs --noEmit`, D044); declaration emit stays on `tsc`

## Commit Guidelines

- One purpose per commit. Do not mix formatting or unrelated refactors
- Message: `area: summary` (for example `store: parse rows with valibot`)
- **Do not push.** Commits stay local until the user asks

## Additional Resources

Read on demand — not every session:

| When | What |
| --- | --- |
| Requirements and scope | `README.md`, `ARCH.md` |
| Research, requirements, tech selection, gates | `docs/process.md` |
| Package boundaries and where types live | `docs/packages.md` |
| Why a decision was made | `docs/decisions.md` (append-only) |
| Stack, tooling, AI-slop gates | `docs/engineering.md` |
| How to review a type | `docs/type-review.md` |
| How to review a finished slice | `docs/review.md` (checks; sources linked per item) |
| Design rules, conditions and sources | `docs/design.md` (read before designing) |
| Comparison with the golden examples | `docs/typescript.md` |
| Current backlog | `work/BOARD.md`, `work/issues/` |
