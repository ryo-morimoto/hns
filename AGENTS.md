# AGENTS.md

## Project Structure

hns is an npm-workspaces monorepo: a self-hosted platform for operating AI agents on several machines from one UI.

### Key Directories

- `packages/` — product code, one package per capability
  - `packages/core` — the model (`src/types.ts`, `src/codecs.ts`), its GraphQL projection (`src/graphql/`), workflow state transitions (`src/workflow.ts`)
  - `packages/store` — SQLite row schemas and `parse*` functions that produce the public model
  - existing: `workspace`, `agent`, `web`; planned: `server`, `machine` (see [docs/packages.md](docs/packages.md))
- `work/` — remaining work and history
  - `work/poc/` — the integrated PoC app (plain JS). **Not product code.** Do not add features here
  - `work/BOARD.md`, `work/issues/` — the backlog and per-issue notes
- `docs/` — flat specs: architecture decisions, auth, safety, observability, packages, type review
- `.githooks/` — `pre-commit`, `pre-push` and `pre-merge-commit` run the gate (`tools/gate/`) through prek, so the hooks see the staged content, not the working tree

### Architecture Notes

- Target package graph: `server → agent / store / workspace → core`; `web → core`. Never the other way
- GraphQL is the one app contract (`@hns/core/graphql` generates the SDL from the model). REST is not declared in advance: the issue that implements a REST face adds its schema, auth, and handler together (D059)
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

`npm run gate` is the commit gate: it reads the staged paths, selects the packages they can break (dependency closure), and runs lint → fmt → typecheck → unit tests on just those. `npm run gate pre-push` runs every stage over every package, including the integration tests, `build`, and `knip`. The hooks call it through `prek`, which hides unstaged changes while they run, after `git config core.hooksPath .githooks` (one line per clone; commit inside `nix develop`). `npm run check` runs the same gate with `--all`.
Building is not proof of correctness; types and tests are.

## Build Commands

| Command                       | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| `npm run gate`                | the commit gate for what is staged                               |
| `npm run check`               | the gate over every package, every stage                         |
| `npm run gate pre-push`       | the push gate: everything, including integration tests and build |
| `npm run gate <stage>`        | one stage: `lint`, `fmt`, `typecheck`, `test`, `build`, `knip`   |
| `npm test -w @hns/store`      | tests for one package                                            |
| `npm run build -w @hns/store` | `dist/` for one package                                          |
| `npm run lint`                | the gate's lint stage over every package                         |
| `npm run fmt`                 | oxfmt, in place                                                  |

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

- **Expected failures are typed.** GraphQL returns errors as unions (0176); a REST face parses and returns its own closed failure union. Do not add new string `error` fields; make it something the caller can branch on
- **Throw `Error`, not values.** A thrown string or object loses the stack and every `instanceof` check downstream. Unexpected failures are `Error` subclasses
- **Await every promise.** Write `void` with a reason when you intentionally ignore one. Catch only the kind you expect and let the rest through

**Safety**

- **Secrets never enter the repo or logs.** Keys live in `~/.config/hns/`. Event logs keep the path and status, never bodies, headers, or tokens
- **Authorization is checked at the boundary.** Never trust UI state or an id sent by the client. Mutations check the caller and the owner at the boundary
- **Never trust input for paths or commands.** Normalize paths and confirm they stay under the workspace root. Run commands through the sandbox (bubblewrap); if the sandbox is unavailable, do not offer exec
- **Fail closed.** Authentication, sandbox availability, and root identity are verified or refused. A check that cannot run is a denial

**Code**

- **Inline comments explain why, not what.** TSDoc on exported APIs and important internal functions is the contract (see Testing). Inline comments stay two or three lines, hard ceiling five; longer reasoning goes to a docstring, README, or decision. Do not restate the same fact in several places
- **Reuse existing guards and helpers.** Reimplementation is the most common AI-authored defect. Look in `packages/core` and the package you are editing first
- **New abstractions need two call sites.** Build for what exists, not for a guessed future
- **Match the surrounding code.** Naming, structure, and comment density come from the adjacent file. The type, validation, and safety rules above win over local style
- **Edit generated files by regenerating them.** Keep headers and regeneration commands intact

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

- **Start from test analysis.** Derive test conditions from the issue's goal, acceptance criteria, docs, and contracts. Record `## テスト条件` and `## テスト設計` in the issue (Example Mapping + Given/When/Then). Test design is a separate step from writing code
- **Choose the lowest layer that can prove the behavior.** One scenario runs in exactly one layer
- **Tests live next to the code.** Unit tests are `packages/<pkg>/src/<module>.test.ts`; integration is `packages/<pkg>/test/integration/`; E2E is `e2e/`. In-source (`if (import.meta.vitest)`) and TSDoc `@example` doctests are for small, pure functions and public contracts
- **Assertions use Vitest `expect`.** For type narrowing, use an explicit check or the `defined()` helper
- **A test names the regression it catches.** Write `// Catches: <bug>` for regression tests. Do not put issue numbers in tests, code, or TODO comments
- Cover failure paths: invalid input, illegal transitions, conflicts, unknown enum values
- Test behavior, not implementation: no assertions on internal helper names, log wording, or CSS. One behavior per test; a test that passes when the logic is broken is not a test
- **TSDoc declares the contract.** Exported APIs and important internal functions document preconditions, invariants, errors, and examples. Tests prove them
- **The issue and TSDoc are the only test-management artifacts; tests are the proof**
- **Make sure the test runs.** Vitest 5 (`vitest run`); the full discipline is in [docs/testing.md](docs/testing.md)

### How to run tests

```bash
npm test -w @hns/store   # that package's unit + integration tests
npm run gate test        # unit tests of the staged packages
npm run check            # everything
```

Inside `nix develop`. Tests use Vitest; the layers and rules are in [docs/testing.md](docs/testing.md).

### Test Structure

Tests live next to the code they prove. Unit tests are `packages/<pkg>/src/<module>.test.ts`; a test that needs another process (rooted helper, pi-env daemon, bubblewrap, a child process) lives in `packages/<pkg>/test/integration/`. E2E is `e2e/` and is not part of `npm run check`. There is no shared fixture package: each package keeps its builders in `test/support/`, and each test creates its own temporary database or directory.

Browser tests (PoC only) look for Chromium; if it is missing they skip. Set `HNS_CHROME` to override the binary.

Existing tests are being migrated: `node:assert` → `expect` (0184), colocation (0186), TSDoc / doctest rollout (0187).

## Review

- **The goal is a change that safely fulfills its contract, not a perfect diff.** Judge behavior over appearance, evidence over suspicion, this change's regressions over pre-existing problems, and signal over volume
- **Independent review after implementation, before commit.** Your own reading is not review. A change in scope is done when `npm run check` passes _and_ an agent that wrote none of the code returns `PASS`. The procedure is [docs/review.md](docs/review.md); read only the invariant files the change touches
- **Only regressions block.** What this change made worse is blocking; what pre-dates it becomes an issue, not a blocker (definition: [docs/review.md](docs/review.md)). Ask for the smallest correction that restores the contract
- **A fix is re-reviewed.** The fix diff is where new defects enter (hns shipped two in one round). The reviewer checks the fix against the boundary schemas and docs it touched
- **Record it.** Verdict, reviewer, HEAD, and blocking findings go in the issue's `## Result` before it is marked `done`

## Linting & Formatting

- **oxlint** with the vendored [anti-slop](https://github.com/dmmulroy/anti-slop) rules (`tools/oxlint/anti-slop/`). Read a rule before disabling it; record every edit to the vendored copy in `UPSTREAM.md`
- **oxfmt** owns whitespace. `require-readable-spacing` is disabled because the two disagree
- `npm run lint` / `npm run fmt`; the pre-commit hook runs the gate (`tools/gate/`), scoped to the staged packages
- Type checks run per workspace (`tsrs --noEmit`, D044); declaration emit is `tsdown` (core; other packages migrate in 0187)

## Commit Guidelines

- One purpose per commit. Do not mix formatting or unrelated refactors
- Message: `area: summary` (for example `store: parse rows with valibot`)
- **Do not push.** Commits stay local until the user asks

## Additional Resources

Read on demand — not every session:

| When                                          | What                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Requirements and scope                        | `README.md`, `ARCH.md`                                             |
| Research, requirements, tech selection, gates | `docs/process.md`                                                  |
| UI/UX and agentic workspace examples          | `docs/design/interface.md` (before) / `docs/review/ux.md` (review) |
| Package boundaries and where types live       | `docs/packages.md`                                                 |
| Why a decision was made                       | `docs/decisions.md` (append-only)                                  |
| Stack, tooling, AI-slop gates                 | `docs/engineering.md`                                              |
| How to review a type                          | `docs/type-review.md`                                              |
| How to review a finished slice                | `docs/review.md` (checks; sources linked per item)                 |
| Design rules, conditions and sources          | `docs/design.md` (read before designing)                           |
| Comparison with the golden examples           | `docs/typescript.md`                                               |
| Current backlog                               | `work/BOARD.md`, `work/issues/`。着手は `priority: now` だけ       |
