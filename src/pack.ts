/**
 * pack.ts — dependency-aware context pack with token budgeting.
 *
 * Given seed file(s), we traverse the graph to find the relevant set, score
 * each candidate by relevance, then greedily include files (closest/most
 * relevant first) until a token budget is exhausted. The output is a concrete
 * artifact an agent can paste into its context window, plus a report of what
 * was included and what was dropped and why.
 */

import { readFileSync } from 'node:fs';
import { traverse, type RepoGraph, type TraversalDirection } from './graph.js';
import { countTokens } from './tokens.js';

export interface PackOptions {
  seeds: string[];
  depth?: number;
  tokenBudget?: number;
  direction?: TraversalDirection;
  /** Weight applied per hop of distance when scoring (higher = penalize distance more). */
  distanceWeight?: number;
}

export interface PackedFile {
  id: string;
  distance: number;
  tokens: number;
  score: number;
  content: string;
}

export interface DroppedFile {
  id: string;
  distance: number;
  tokens: number;
  score: number;
  reason: 'budget';
}

export interface ContextPack {
  seeds: string[];
  depth: number;
  direction: TraversalDirection;
  tokenBudget: number | null;
  included: PackedFile[];
  dropped: DroppedFile[];
  totalTokens: number;
  /** Tokens of every candidate file before budgeting (the relevant-set cost). */
  candidateTokens: number;
}

/**
 * Relevance score for a candidate file. Lower distance is better. We also give
 * a small bonus to hub files (highly imported) at the *same* distance because,
 * for an agent, shared utilities are disproportionately useful context.
 *
 * Score is "lower = include earlier".
 */
function scoreFile(
  graph: RepoGraph,
  id: string,
  distance: number,
  distanceWeight: number,
): number {
  const node = graph.nodes.get(id);
  const hubBonus = node ? Math.log2(1 + node.importedBy.size) : 0;
  // Distance dominates; hub bonus only breaks ties within a ring.
  return distance * distanceWeight - hubBonus * 0.01;
}

export function buildPack(graph: RepoGraph, opts: PackOptions): ContextPack {
  const depth = opts.depth ?? 2;
  const direction = opts.direction ?? 'both';
  const tokenBudget = opts.tokenBudget ?? null;
  const distanceWeight = opts.distanceWeight ?? 1;

  const { distances } = traverse(graph, opts.seeds, depth, direction);

  // Build candidate list with content + tokens + score.
  interface Candidate {
    id: string;
    distance: number;
    tokens: number;
    score: number;
    content: string;
  }
  const candidates: Candidate[] = [];
  for (const [id, distance] of distances) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    let content = '';
    try {
      content = readFileSync(node.absPath, 'utf8');
    } catch {
      content = '';
    }
    candidates.push({
      id,
      distance,
      tokens: countTokens(content),
      score: scoreFile(graph, id, distance, distanceWeight),
      content,
    });
  }

  const candidateTokens = candidates.reduce((sum, c) => sum + c.tokens, 0);

  // Sort: best score first; ties broken by smaller files then path so output
  // is deterministic. Seeds (distance 0) always sort first.
  candidates.sort(
    (a, b) =>
      a.score - b.score || a.tokens - b.tokens || a.id.localeCompare(b.id),
  );

  const included: PackedFile[] = [];
  const dropped: DroppedFile[] = [];
  let used = 0;

  for (const c of candidates) {
    const isSeed = c.distance === 0;
    if (tokenBudget !== null && !isSeed && used + c.tokens > tokenBudget) {
      // Drop non-seed files that would blow the budget. Seeds are always kept:
      // the task literally is about them, so dropping them is never useful.
      dropped.push({
        id: c.id,
        distance: c.distance,
        tokens: c.tokens,
        score: c.score,
        reason: 'budget',
      });
      continue;
    }
    included.push({
      id: c.id,
      distance: c.distance,
      tokens: c.tokens,
      score: c.score,
      content: c.content,
    });
    used += c.tokens;
  }

  return {
    seeds: opts.seeds,
    depth,
    direction,
    tokenBudget,
    included,
    dropped,
    totalTokens: used,
    candidateTokens,
  };
}

/**
 * Render a context pack as a single text artifact suitable for pasting into an
 * LLM. Each file is fenced with a clear header an agent can rely on.
 */
export function renderPack(pack: ContextPack): string {
  const lines: string[] = [];
  lines.push('# Context Pack');
  lines.push(`# seeds: ${pack.seeds.join(', ')}`);
  lines.push(`# depth: ${pack.depth}  direction: ${pack.direction}`);
  lines.push(
    `# files: ${pack.included.length} included, ${pack.dropped.length} dropped  ` +
      `tokens: ${pack.totalTokens}` +
      (pack.tokenBudget !== null ? ` / ${pack.tokenBudget} budget` : ''),
  );
  lines.push('');
  for (const f of pack.included) {
    lines.push(`===== FILE: ${f.id} (distance ${f.distance}, ~${f.tokens} tokens) =====`);
    lines.push(f.content.replace(/\s+$/, ''));
    lines.push('');
  }
  return lines.join('\n');
}

/** Total tokens of the entire repo (the "no packing" baseline). */
export function fullRepoTokens(graph: RepoGraph): number {
  let total = 0;
  for (const node of graph.nodes.values()) {
    try {
      total += countTokens(readFileSync(node.absPath, 'utf8'));
    } catch {
      /* ignore */
    }
  }
  return total;
}
