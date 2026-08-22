/**
 * graph.ts — repo discovery, module resolution, dependency graph + traversal.
 *
 * The graph is directional: an edge A -> B means "A imports B".
 * We also keep the reverse (importers) so we can traverse both ways: an agent
 * fixing file X cares about what X imports (its dependencies) *and* what imports
 * X (its blast radius / dependents).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, dirname } from 'node:path';
import { parseSource, isSupportedSource, SUPPORTED_EXTENSIONS, type ParseResult } from './parser.js';

export interface FileNode {
  /** Repo-relative path, POSIX-style, used as the stable node id. */
  id: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Files this file imports (resolved to repo-relative ids). */
  imports: Set<string>;
  /** Files that import this file. */
  importedBy: Set<string>;
  /** External (node_modules / unresolved) specifiers, kept for reporting. */
  externalImports: string[];
  /** Byte size of the file. */
  size: number;
  /** Parser strategy used for this file. */
  strategy: ParseResult['strategy'];
}

export interface RepoGraph {
  root: string;
  nodes: Map<string, FileNode>;
  /** Total number of internal edges (resolved imports). */
  edgeCount: number;
}

const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '__pycache__',
]);

/** Recursively list supported source files under `dir`. */
export function listSourceFiles(dir: string, ignore: Set<string> = DEFAULT_IGNORE): string[] {
  const root = resolve(dir);
  const found: string[] = [];

  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        if (ignore.has(entry.name)) continue;
      }
      if (ignore.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isSupportedSource(full)) {
        // Skip declaration files — they describe types, not runtime modules.
        if (full.endsWith('.d.ts')) continue;
        found.push(full);
      }
    }
  };

  walk(root);
  return found.sort();
}

/** POSIX-normalize a path so node ids are consistent across platforms. */
function toId(root: string, absPath: string): string {
  return relative(root, absPath).split('\\').join('/');
}

/**
 * Resolve a relative import specifier to a concrete file id within the repo.
 * Mirrors Node/TS resolution for the common cases:
 *   "./foo"        -> foo.ts | foo.tsx | foo/index.ts ...
 *   "./foo.js"     -> foo.ts  (TS source for an emitted .js specifier)
 * Returns null for bare specifiers (npm packages) and unresolved paths.
 */
export function resolveImport(
  fromAbsFile: string,
  specifier: string,
  fileSet: Set<string>,
): string | null {
  // Only resolve relative imports — bare specifiers are external.
  if (!specifier.startsWith('.')) return null;

  const baseDir = dirname(fromAbsFile);
  const target = resolve(baseDir, specifier);

  const candidates: string[] = [];

  // Strip a trailing .js/.jsx/.mjs/.cjs that TS/ESM uses to point at TS source.
  const ext = extname(target);
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const noExt = target.slice(0, -ext.length);
    for (const e of SUPPORTED_EXTENSIONS) candidates.push(noExt + e);
  }

  // Exact path (with extension).
  candidates.push(target);

  // Append each supported extension.
  for (const e of SUPPORTED_EXTENSIONS) candidates.push(target + e);

  // Directory index files.
  for (const e of SUPPORTED_EXTENSIONS) candidates.push(join(target, 'index' + e));

  for (const c of candidates) {
    if (fileSet.has(c)) return c;
  }
  return null;
}

/** Build a dependency graph from a directory. */
export async function buildGraph(dir: string): Promise<RepoGraph> {
  const root = resolve(dir);
  const absFiles = listSourceFiles(root);
  const fileSet = new Set(absFiles);

  const nodes = new Map<string, FileNode>();
  for (const abs of absFiles) {
    const id = toId(root, abs);
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      /* ignore */
    }
    nodes.set(id, {
      id,
      absPath: abs,
      imports: new Set(),
      importedBy: new Set(),
      externalImports: [],
      size,
      strategy: 'regex',
    });
  }

  let edgeCount = 0;

  for (const abs of absFiles) {
    const id = toId(root, abs);
    const node = nodes.get(id)!;
    let code = '';
    try {
      code = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const parsed = await parseSource(abs, code);
    node.strategy = parsed.strategy;

    for (const imp of parsed.imports) {
      const resolved = resolveImport(abs, imp.specifier, fileSet);
      if (resolved) {
        const targetId = toId(root, resolved);
        if (targetId !== id && !node.imports.has(targetId)) {
          node.imports.add(targetId);
          nodes.get(targetId)!.importedBy.add(id);
          edgeCount += 1;
        }
      } else {
        node.externalImports.push(imp.specifier);
      }
    }
  }

  return { root, nodes, edgeCount };
}

export type TraversalDirection = 'imports' | 'importers' | 'both';

export interface TraversalResult {
  /** Map of file id -> shortest hop distance from any seed (0 = seed). */
  distances: Map<string, number>;
  /** Ordered list of reached ids (BFS order, seeds first). */
  order: string[];
}

/**
 * Breadth-first traversal from one or more seeds, up to `depth` hops.
 * `direction` controls which edges are followed:
 *   - imports:   follow dependencies (what the seed needs)
 *   - importers: follow dependents (blast radius)
 *   - both:      follow both (recommended default for context packing)
 */
export function traverse(
  graph: RepoGraph,
  seeds: string[],
  depth: number,
  direction: TraversalDirection = 'both',
): TraversalResult {
  const distances = new Map<string, number>();
  const order: string[] = [];
  const queue: Array<{ id: string; dist: number }> = [];

  for (const seed of seeds) {
    if (graph.nodes.has(seed) && !distances.has(seed)) {
      distances.set(seed, 0);
      order.push(seed);
      queue.push({ id: seed, dist: 0 });
    }
  }

  while (queue.length > 0) {
    const { id, dist } = queue.shift()!;
    if (dist >= depth) continue;
    const node = graph.nodes.get(id);
    if (!node) continue;

    const neighbors: string[] = [];
    if (direction === 'imports' || direction === 'both') {
      neighbors.push(...node.imports);
    }
    if (direction === 'importers' || direction === 'both') {
      neighbors.push(...node.importedBy);
    }

    for (const nb of neighbors) {
      if (!distances.has(nb)) {
        distances.set(nb, dist + 1);
        order.push(nb);
        queue.push({ id: nb, dist: dist + 1 });
      }
    }
  }

  return { distances, order };
}

/** Files sorted by how many other files import them (most-depended-on first). */
export function mostDependedOn(graph: RepoGraph, limit = 10): Array<{ id: string; count: number }> {
  return [...graph.nodes.values()]
    .map((n) => ({ id: n.id, count: n.importedBy.size }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/** Direct + transitive dependents of a file (its full blast radius). */
export function blastRadius(graph: RepoGraph, fileId: string): Set<string> {
  const result = new Set<string>();
  const stack = [fileId];
  while (stack.length) {
    const cur = stack.pop()!;
    const node = graph.nodes.get(cur);
    if (!node) continue;
    for (const dep of node.importedBy) {
      if (!result.has(dep)) {
        result.add(dep);
        stack.push(dep);
      }
    }
  }
  return result;
}
