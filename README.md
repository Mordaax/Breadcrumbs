# Breadcrumbs

`rcca` is a TypeScript CLI that selects source files for an AI coding agent's context. Give it a repository, one or more starting files and a token budget. It follows imports and dependents, ranks nearby files and writes a context pack.

This is a standalone prototype for working with TypeScript repositories such as [Rocket.Chat](https://github.com/RocketChat/Rocket.Chat). It has not been integrated into Rocket.Chat.

## How it works

The indexer scans `.ts/.tsx/.js/.jsx/.mjs/.cjs` files and resolves imports, requires, dynamic imports and re-exports into a directed graph. It also stores reverse edges so it can find a file's dependents.

Packing starts with a bounded breadth-first traversal from the seed files. Nearby files rank first, with a small preference for shared dependencies. The packer includes files until it reaches `--token-budget` and reports what it omitted. Seed files are always included, even when they exceed the budget.

The `changed` command uses `git diff` to find modified files and their transitive dependents. The `report` command compares an example pack with the full repository. Counts use the `chars / 4` estimate described under [Token estimation](#token-estimation).

## Install & build

Requires Node ≥ 20 (developed on Node 22, npm 11).

```bash
cd 06-rocketchat-code-analyzer
npm install      # installs typescript + tsx + @types/node (dev only)
npm run build    # tsc -> dist/  (must succeed with no type errors)
npm test         # node:test suite (parser, graph, pack)
```

The parser loads `typescript` when available and falls back to a regex scanner otherwise. Running from source still requires `tsx`; building requires the development dependencies. A compiled CLI can use the fallback with Node's built-ins.

## Usage

You can run without building via the `rcca` script (uses `tsx`):

```bash
npm run rcca -- <command> <args>
```

…or after `npm run build`, run the compiled CLI directly:

```bash
node dist/cli.js <command> <args>
# or, if linked:  rcca <command> <args>
```

### `rcca index <dir>`: graph stats

```bash
npm run rcca -- index fixtures/sample-repo
```

```
Repo: .../fixtures/sample-repo
Parser: typescript
Files: 10
Edges (internal imports): 16
External imports (npm/unresolved): 0

Most-depended-on files:
    6  src/utils/logger.ts
    3  src/models/user.model.ts
    2  src/services/user.ts
    2  src/utils/validation.ts
    1  src/api/routes.ts
    1  src/db/repository.ts
    1  src/services/channel.ts

Isolated files (no internal edges): 1
  src/standalone.ts
```

### `rcca pack <dir> --seed <file>`: context pack + budget report

The report goes to stderr; the pack artifact goes to stdout (so
you can pipe it). Use `--out <file>` to write the pack to a file, or
`--list-only` to print just the file list.

```bash
npm run rcca -- pack fixtures/sample-repo \
  --seed src/index.ts --depth 3 --direction imports --token-budget 300 --list-only
```

```
Seeds: src/index.ts
Depth: 3  Direction: imports
Relevant set: 8 files, ~1,037 tokens
Included: 3 files, ~292 tokens (budget 300)
Included files (by relevance):
  [d0] src/index.ts  (~74 tok)
  [d1] src/utils/logger.ts  (~114 tok)
  [d3] src/models/user.model.ts  (~104 tok)
Dropped (over budget): 5
  [d1] src/api/routes.ts  (~196 tok)
  [d2] src/services/user.ts  (~179 tok)
  ...
Budget report: full repo ~1,149 tok -> pack ~292 tok  (saved 74.6%)
src/index.ts
src/utils/logger.ts
src/models/user.model.ts
```

Drop `--list-only` (and `--token-budget`) to emit the full concatenated context
pack to stdout:

```bash
npm run rcca -- pack fixtures/sample-repo --seed src/services/user.ts --out pack.txt
```

Flags:

| flag | default | meaning |
|------|---------|---------|
| `--seed <file>` | *(required)* | seed file; repeatable / comma-separated. Accepts repo-relative path, absolute path, or unique basename. |
| `--depth <n>` | `2` | max BFS hops from the seed |
| `--direction <both\|imports\|importers>` | `both` | which edges to follow |
| `--token-budget <n>` | *(none)* | cap pack size; seeds are always kept |
| `--out <file>` | *(stdout)* | write the pack artifact to a file |
| `--list-only` | off | print only the included file paths |

### `rcca changed <dir>`: changed files + blast radius

```bash
npm run rcca -- changed fixtures/sample-repo            # vs HEAD (working tree + staged)
npm run rcca -- changed fixtures/sample-repo --base main # vs a branch/ref
```

```
Changed source files: 2
  M   src/models/user.model.ts  (+4/-1)
  M   src/utils/validation.ts   (+2/-0)

Blast radius (dependents that may need re-testing):
  src/models/user.model.ts -> 6 dependent(s)
      src/api/routes.ts
      src/services/user.ts
      ...
Affected set (changed + dependents): 8 files
```

### `rcca report <dir>`: tokens saved

```bash
npm run rcca -- report fixtures/sample-repo --token-budget 400
```

```
Full-repo context: ~1,149 tokens
Typical pack (seed=src/utils/logger.ts, depth=2, budget=400):
  Files included: 3 / 10
  Pack tokens: ~364
  Tokens saved vs full repo: 68.3% (785 fewer tokens)
```

These examples use the bundled 10-file fixture. The percentages describe estimated input size for those commands, not measured changes in model cost, latency or answer quality. Results on other repositories depend on the seed, graph and budget.

## Using it with an agent

An agent can call `rcca pack` before editing a file and read the resulting context pack. `pack --list-only` returns paths for tools that read files themselves. Reports go to stderr, leaving stdout available for the pack.

`rcca changed` lists dependents that may need retesting. It does not map source files to test cases, so a CI integration would need its own test-selection rules.

An MCP wrapper such as `get_context(seed, budget)` is a possible integration, but no MCP server is included. See ARCHITECTURE.md.

Example shell integration:

```bash
# Agent is about to fix a bug in user.ts — fetch just what it needs:
npm run rcca -- pack ./packages/core --seed src/services/user.ts \
  --token-budget 8000 --out /tmp/ctx.md
# -> /tmp/ctx.md now holds the minimal relevant slice, under budget.
```

## Token estimation

The default counter estimates tokens with `chars / 4`, so the budget is approximate. `src/tokens.ts` exposes `setTokenizer()` for a model-specific tokenizer such as `tiktoken` or `@anthropic-ai/tokenizer`, without changing the packer's callers.

## Project layout

```
06-rocketchat-code-analyzer/
├── package.json          scripts: build / test / rcca / start  +  bin: rcca
├── tsconfig.json         strict, NodeNext ESM, dist/ output
├── src/
│   ├── parser.ts         import extraction (TS compiler API + regex fallback)
│   ├── graph.ts          discovery, module resolution, graph + BFS traversal
│   ├── pack.ts           context pack assembly + greedy token budgeting
│   ├── git.ts            changed files via git + blast radius
│   ├── tokens.ts         token estimator (chars/4) + swappable tokenizer seam
│   └── cli.ts            zero-dependency arg parser + commands
├── test/                 node:test suites (parser, graph traversal, pack budget)
├── fixtures/sample-repo/ small interlinked TS app to demo / test on
├── README.md
└── ARCHITECTURE.md       module breakdown, algorithms, design decisions, deferred
```

## Limitations

Selection is based on imports and graph distance. It can miss relevant files that have no dependency edge to the seeds, and the regex parser is a fallback for environments without the TypeScript compiler API. Semantic ranking, LLM-based relevance checks and an MCP server are deferred. See ARCHITECTURE.md.

## License

MIT.
