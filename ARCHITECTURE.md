# Architecture — rcca

This document covers the module breakdown, the graph/traversal algorithm, the
token-budget greedy strategy, the design decisions behind them, and the
deliberately deferred work.

---

## 1. Module breakdown

The code is split so each module has one job and a narrow dependency surface.
Dependencies flow one way: `cli → {graph, pack, git, tokens}`, `pack → {graph,
tokens}`, `graph → parser`, `git → graph`. Nothing imports `cli`.

| Module | Responsibility | Key exports |
|--------|----------------|-------------|
| `src/parser.ts` | Turn source text into a list of import specifiers. TS compiler API primary, regex fallback. | `parseSource`, `parseFile`, `parseWithRegex`, `stripComments` |
| `src/graph.ts` | Discover files, resolve specifiers to in-repo files, build the directed graph, traverse it. | `buildGraph`, `traverse`, `mostDependedOn`, `blastRadius`, `resolveImport`, `listSourceFiles` |
| `src/pack.ts` | Assemble a context pack from a traversal and enforce a token budget. | `buildPack`, `renderPack`, `fullRepoTokens` |
| `src/git.ts` | Detect changed source files via `git` and compute blast radius. | `changedFiles` |
| `src/tokens.ts` | Estimate tokens; provide a swappable tokenizer seam. | `estimateTokens`, `countTokens`, `setTokenizer`, `percentSaved` |
| `src/cli.ts` | Parse argv (hand-rolled) and dispatch to commands. | `main` (entry) |

### The data model

`buildGraph` returns a `RepoGraph`:

```ts
interface FileNode {
  id: string;             // repo-relative, POSIX-normalized — the stable node id
  absPath: string;
  imports: Set<string>;       // edges OUT: files this file imports
  importedBy: Set<string>;    // edges IN:  files that import this file
  externalImports: string[];  // npm / unresolved specifiers, kept for reporting
  size: number;
  strategy: 'typescript' | 'regex';
}
interface RepoGraph { root: string; nodes: Map<string, FileNode>; edgeCount: number; }
```

Storing **both** directions (`imports` and `importedBy`) is the central design
choice: an agent task cares about a file's *dependencies* (what it needs to
understand to change it) **and** its *dependents* (what its change might break).
Maintaining both as sets makes traversal O(1) per neighbour lookup and keeps the
two views consistent (every edge is recorded on both endpoints during build).

---

## 2. Import extraction (`parser.ts`)

Two strategies, chosen at runtime:

1. **TypeScript compiler API (preferred).** `typescript` is loaded via dynamic
   `import()` so it is a *soft* dependency. We build a `SourceFile` (with the
   correct `ScriptKind` for `.ts/.tsx/.js/.jsx`) and walk the AST, collecting:
   - `import … from "x"` and side-effect `import "x"` → `import`
   - `import type` → `import` (still a real file dependency for context)
   - `export … from "x"`, `export * from "x"` → `export-from`
   - `import foo = require("x")` (TS import-equals) → `require`
   - `require("x")` calls → `require`
   - `import("x")` dynamic calls → `dynamic`

   Using the compiler means we never hand-write a JS/TS grammar and we correctly
   ignore imports inside strings, comments, and template literals.

2. **Regex fallback.** If `typescript` can't be loaded (offline install), we
   first strip comments with a small string-aware scanner (`stripComments` —
   it tracks string/template state so it won't strip `//` inside a URL string),
   then match the common import forms with anchored regexes. Less precise on
   exotic syntax, but covers the forms that matter and keeps the tool running
   with **zero** runtime dependencies.

`parseSource` tries the compiler, and if the AST pass throws for any reason it
degrades to regex rather than failing the whole index. Tests exercise both paths
(`_disableTypeScriptForTesting()` forces the fallback).

### Module resolution (`resolveImport`)

We only resolve **relative** specifiers (`./`, `../`); bare specifiers are
treated as external (npm) and recorded for reporting, not as graph edges. For a
relative specifier we try, in order:

- a trailing `.js/.jsx/.mjs/.cjs` rewritten to TS source (TS/ESM commonly import
  `./foo.js` to mean `foo.ts`) — this is essential for real TS codebases;
- the exact path;
- the path + each supported extension;
- `path/index.{ext}` (directory index).

The first candidate that exists in the discovered file set wins. `.d.ts` files
are excluded from discovery (they describe types, not runtime modules), as are
`node_modules`, `.git`, `dist`, `build`, etc.

---

## 3. Graph traversal algorithm

`traverse(graph, seeds, depth, direction)` is a **bounded breadth-first search**
that records the shortest hop distance from any seed.

```
distances = {}            # id -> shortest hop count
queue = []
for seed in seeds:        # seeds enter at distance 0
    distances[seed] = 0; enqueue(seed, 0)

while queue not empty:
    (id, dist) = dequeue()
    if dist >= depth: continue          # depth bound
    neighbours = []
    if direction in {imports, both}:  neighbours += node.imports
    if direction in {importers, both}: neighbours += node.importedBy
    for nb in neighbours:
        if nb not in distances:         # first visit = shortest path (BFS)
            distances[nb] = dist + 1; enqueue(nb, dist + 1)
```

Properties:

- **BFS ⇒ distances are shortest paths.** The first time a node is reached is via
  a minimum-hop path, which is exactly the relevance signal we want (closer =
  more relevant).
- **Direction is a parameter.** `imports` = dependencies only, `importers` =
  dependents only (blast radius), `both` = the full neighbourhood (default for
  packing).
- **Multi-seed.** All seeds start at distance 0; a node's distance is its
  distance to the *nearest* seed. This lets an agent pass several files it's
  touching and get their combined neighbourhood.
- **Complexity.** O(V + E) within the explored radius; sets give O(1) neighbour
  membership.

`blastRadius(graph, fileId)` is a separate full (unbounded) DFS over
`importedBy` used by `rcca changed` — for "what could this diff break" we want
the *transitive* closure, not a depth-limited slice.

---

## 4. Token-budget greedy strategy (`pack.ts`)

The pack problem: given the relevant set (the traversal result) and a token
budget, choose which files to include. This is a knapsack-flavoured problem, but
for context selection a **greedy, relevance-ordered** fill is both the right
behaviour and simple to reason about:

1. **Score every candidate.** `score = distance * distanceWeight − hubBonus·0.01`
   where `hubBonus = log2(1 + importedBy.size)`. Lower score = include earlier.
   Distance dominates; the tiny hub bonus only breaks ties *within the same
   distance ring*, nudging shared utilities (highly imported files) ahead of
   equally-distant leaf files because they tend to be disproportionately useful
   context.
2. **Sort** by `(score, tokens, id)` — closest first, then smaller files, then
   path for determinism.
3. **Greedily fill.** Walk the sorted list; include a file if it fits the
   remaining budget. **Seeds (distance 0) are always included** even if they
   exceed the budget — the task *is* about them, so dropping them is never
   useful; only non-seed files are subject to the cap.
4. **Report** `included` and `dropped` (with reason `budget`), plus
   `candidateTokens` (the cost of the whole relevant set before budgeting) and
   `totalTokens` (the packed cost).

### Why greedy and not optimal knapsack?

- Relevance ordering is the actual objective. We don't want to maximise files-
  per-token; we want the *most relevant* files that fit. A closer file is more
  valuable than two farther ones even if the two are cheaper.
- It's deterministic, explainable ("we kept the seed + its closest deps, dropped
  the far ones"), and O(n log n). An agent — and a human reviewer — can trust it.
- Smaller-file tie-breaking within a ring is a light nod toward fitting more
  useful files when relevance is equal, without turning it into a packing solver.

The greedy fill guarantees the **non-seed** token sum never exceeds the budget
(tested in `pack.test.ts`).

### Rendering

`renderPack` emits a single text artifact: a header (seeds, depth, counts,
tokens vs budget) followed by each file fenced with
`===== FILE: <id> (distance N, ~T tokens) =====`. The headers are stable so an
agent can split the artifact back into files if it wants to.

---

## 5. Changed-file blast radius (`git.ts`)

`rcca changed` shells out to `git` (no library) and is defensive about edge
cases: not-a-repo, no commits yet, dirty vs clean tree, renames. It uses
`git diff --name-status <base>` + `git diff --numstat <base>` (default base
`HEAD`, override with `--base`). For a repo with no commits it falls back to
`git status --porcelain`. Each changed source file is mapped to a graph node id
(relative to the graph root, which may be below the git toplevel) and its
transitive dependents are computed via `blastRadius`. The union (changed +
dependents) is the suggested test/context set.

---

## 6. CLI design (`cli.ts`)

A hand-rolled argument parser (≈40 lines) instead of `commander`. The command
surface is small (4 commands, ~6 flags) and the offline promise is easier to
keep with zero runtime deps. Conventions:

- **Reports → stderr, artifacts → stdout.** `rcca pack` prints its human report
  to stderr and the pack to stdout, so `rcca pack … > pack.txt` yields a clean
  artifact and the report still shows in the terminal.
- **Flexible seeds.** `--seed` accepts a repo-relative id, an absolute path, or a
  unique basename, and is repeatable / comma-separable.
- Swapping in `commander` later is a drop-in if richer help/validation is wanted.

---

## 7. Key design decisions (summary)

| Decision | Why |
|----------|-----|
| Soft dependency on `typescript` (lazy `import`) + regex fallback | Robust parsing when online; still runs offline with only Node built-ins. |
| Store both `imports` and `importedBy` | Agents need dependencies *and* blast radius; both directions in one graph. |
| `chars/4` token estimate, swappable via `setTokenizer` | Offline-friendly; accurate enough for budgeting; real tokenizer is a one-line swap. |
| Greedy relevance-ordered budgeting, seeds always kept | Matches the real objective (most-relevant-that-fits), deterministic, explainable. |
| BFS shortest-hop distance as the relevance signal | Simple, language-agnostic, correlates well with "what you need to read". |
| Reports on stderr, pack on stdout | Pipe-friendly for agent / shell integration. |
| Hand-rolled CLI parser | Keeps the zero-runtime-dependency story; surface is small. |

---

## 8. Deferred (documented, intentionally NOT implemented)

These are the natural next steps. They are out of scope for this PoC and are
listed so the boundary is explicit.

- **LLM-in-the-loop agent runs.** Actually invoking an LLM — e.g. an agent loop
  that calls `rcca pack`, reads the slice, asks the model what *else* it needs,
  and expands the seed set iteratively. No model is called anywhere in this PoC.
- **Embedding / semantic relevance.** Right now relevance = graph distance.
  A stronger signal would combine graph distance with semantic similarity
  (embed the task description and each file, rank by cosine). This needs an
  embedding model + a vector store and is deliberately omitted. The scoring
  function in `pack.ts` is the single seam where a semantic score would be mixed
  into the existing distance/hub score.
- **A real tokenizer.** `setTokenizer()` exists precisely so `tiktoken` /
  `@anthropic-ai/tokenizer` can replace the heuristic without code changes.
- **MCP server / editor integration.** Wrapping `rcca pack` and `rcca changed`
  as MCP tools (or a Claude Code slash command) so an agent calls them directly.
  The CLI's stdout/stderr split already anticipates this; the server itself is
  not built.
- **Symbol-level granularity.** Today the unit is a file. A future version could
  pack only the *symbols* (functions/classes) actually referenced, shrinking
  packs further — requires symbol-resolution on top of the import graph.
- **Monorepo path aliases / `tsconfig` `paths`.** `resolveImport` handles
  relative + index + extension rewriting but not workspace path aliases
  (`@rocket.chat/...`). Reading `tsconfig.json` `paths` / workspace globs is a
  clear extension point for resolving more bare specifiers as internal edges.
