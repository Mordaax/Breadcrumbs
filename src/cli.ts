#!/usr/bin/env node
/**
 * cli.ts — `rcca` command-line interface.
 *
 * Hand-rolled argument parser (zero dependencies) so the tool runs even when
 * `npm install` cannot reach the network. Commander would be a drop-in, but
 * the surface here is small enough that a tiny parser keeps the offline promise.
 *
 * Commands:
 *   rcca index   <dir>
 *   rcca pack    <dir> --seed <file> [--depth N] [--token-budget N] [--out file] [--direction both|imports|importers]
 *   rcca changed <dir> [--base <ref>]
 *   rcca report  <dir> [--depth N] [--token-budget N]
 */

import { writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { buildGraph, mostDependedOn, type RepoGraph } from './graph.js';
import { buildPack, renderPack, fullRepoTokens } from './pack.js';
import { changedFiles } from './git.js';
import { formatTokens, percentSaved } from './tokens.js';

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  // Flags that may be repeated (collected as comma-joined).
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, true);
      } else {
        // Support repeated --seed by joining with comma.
        if (flags.has(key)) {
          flags.set(key, `${flags.get(key)},${next}`);
        } else {
          flags.set(key, next);
        }
        i++;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { command, positionals, flags };
}

function flagStr(flags: Map<string, string | boolean>, key: string): string | undefined {
  const v = flags.get(key);
  return typeof v === 'string' ? v : undefined;
}

function flagInt(flags: Map<string, string | boolean>, key: string, dflt: number): number {
  const v = flagStr(flags, key);
  if (v === undefined) return dflt;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

function requireDir(positionals: string[]): string {
  const dir = positionals[0];
  if (!dir) fail('missing <dir> argument');
  const abs = resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    fail(`not a directory: ${dir}`);
  }
  return abs;
}

function fail(msg: string): never {
  process.stderr.write(`rcca: error: ${msg}\n`);
  process.exit(1);
}

/** Resolve a user-supplied seed path to a graph node id. */
function seedToId(graph: RepoGraph, raw: string): string | null {
  // Try as a relative-to-root id directly.
  const direct = raw.split('\\').join('/');
  if (graph.nodes.has(direct)) return direct;
  // Try resolving against cwd then relativizing to root.
  const abs = resolve(raw);
  const id = relative(graph.root, abs).split('\\').join('/');
  if (graph.nodes.has(id)) return id;
  // Try matching by suffix (convenience: --seed user.ts).
  const matches = [...graph.nodes.keys()].filter((k) => k === raw || k.endsWith('/' + raw));
  if (matches.length === 1) return matches[0];
  return null;
}

const HELP = `rcca — Rocket.Chat Code Analyzer (dependency-aware context packing)

Usage:
  rcca index   <dir>
  rcca pack    <dir> --seed <file> [--seed <file2> ...] [--depth N]
                     [--token-budget N] [--direction both|imports|importers]
                     [--out <file>] [--list-only]
  rcca changed <dir> [--base <git-ref>]
  rcca report  <dir> [--depth N] [--token-budget N] [--seed <file>]

Examples:
  rcca index fixtures/sample-repo
  rcca pack fixtures/sample-repo --seed src/services/user.ts --depth 2 --token-budget 2000
  rcca changed fixtures/sample-repo
  rcca report fixtures/sample-repo --token-budget 2000
`;

async function cmdIndex(dir: string): Promise<void> {
  const graph = await buildGraph(dir);
  const strategies = new Set([...graph.nodes.values()].map((n) => n.strategy));
  process.stdout.write(`Repo: ${dir}\n`);
  process.stdout.write(`Parser: ${[...strategies].join(', ')}\n`);
  process.stdout.write(`Files: ${graph.nodes.size}\n`);
  process.stdout.write(`Edges (internal imports): ${graph.edgeCount}\n`);

  const externalCount = [...graph.nodes.values()].reduce(
    (s, n) => s + n.externalImports.length,
    0,
  );
  process.stdout.write(`External imports (npm/unresolved): ${externalCount}\n`);

  process.stdout.write('\nMost-depended-on files:\n');
  for (const { id, count } of mostDependedOn(graph, 10)) {
    if (count === 0) continue;
    process.stdout.write(`  ${count.toString().padStart(3)}  ${id}\n`);
  }

  // Orphans: files nobody imports and that import nothing internal.
  const orphans = [...graph.nodes.values()].filter(
    (n) => n.imports.size === 0 && n.importedBy.size === 0,
  );
  if (orphans.length) {
    process.stdout.write(`\nIsolated files (no internal edges): ${orphans.length}\n`);
    for (const o of orphans.slice(0, 10)) process.stdout.write(`  ${o.id}\n`);
  }
}

async function cmdPack(dir: string, flags: Map<string, string | boolean>): Promise<void> {
  const graph = await buildGraph(dir);
  const seedRaw = flagStr(flags, 'seed');
  if (!seedRaw) fail('pack requires --seed <file>');

  const seedIds: string[] = [];
  for (const s of seedRaw.split(',')) {
    const id = seedToId(graph, s.trim());
    if (!id) fail(`seed not found in repo: ${s.trim()}`);
    seedIds.push(id);
  }

  const depth = flagInt(flags, 'depth', 2);
  const tokenBudget = flags.has('token-budget')
    ? flagInt(flags, 'token-budget', 8000)
    : null;
  const direction = (flagStr(flags, 'direction') ?? 'both') as
    | 'both'
    | 'imports'
    | 'importers';

  const pack = buildPack(graph, {
    seeds: seedIds,
    depth,
    tokenBudget: tokenBudget ?? undefined,
    direction,
  });

  const listOnly = flags.has('list-only');
  const outFile = flagStr(flags, 'out');

  // Always write the human report to stderr so stdout can be piped cleanly.
  const report: string[] = [];
  report.push(`Seeds: ${seedIds.join(', ')}`);
  report.push(`Depth: ${depth}  Direction: ${direction}`);
  report.push(
    `Relevant set: ${pack.included.length + pack.dropped.length} files, ` +
      `~${formatTokens(pack.candidateTokens)} tokens`,
  );
  report.push(
    `Included: ${pack.included.length} files, ~${formatTokens(pack.totalTokens)} tokens` +
      (tokenBudget !== null ? ` (budget ${formatTokens(tokenBudget)})` : ''),
  );
  report.push('Included files (by relevance):');
  for (const f of pack.included) {
    report.push(`  [d${f.distance}] ${f.id}  (~${f.tokens} tok)`);
  }
  if (pack.dropped.length) {
    report.push(`Dropped (over budget): ${pack.dropped.length}`);
    for (const f of pack.dropped) {
      report.push(`  [d${f.distance}] ${f.id}  (~${f.tokens} tok)`);
    }
  }
  const full = fullRepoTokens(graph);
  report.push(
    `Budget report: full repo ~${formatTokens(full)} tok -> pack ~${formatTokens(
      pack.totalTokens,
    )} tok  (saved ${percentSaved(full, pack.totalTokens)}%)`,
  );
  process.stderr.write(report.join('\n') + '\n');

  if (listOnly) {
    for (const f of pack.included) process.stdout.write(f.id + '\n');
    return;
  }

  const rendered = renderPack(pack);
  if (outFile) {
    writeFileSync(outFile, rendered, 'utf8');
    process.stderr.write(`\nWrote context pack to ${outFile}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

async function cmdChanged(dir: string, flags: Map<string, string | boolean>): Promise<void> {
  const graph = await buildGraph(dir);
  const base = flagStr(flags, 'base') ?? 'HEAD';
  const rep = changedFiles(graph, base);

  process.stdout.write(`Git repo: ${rep.isGitRepo ? 'yes' : 'no'}  (base: ${rep.base})\n`);
  if (rep.note) process.stdout.write(`Note: ${rep.note}\n`);
  if (!rep.changed.length) return;

  process.stdout.write(`\nChanged source files: ${rep.changed.length}\n`);
  for (const cf of rep.changed) {
    process.stdout.write(
      `  ${cf.status.padEnd(3)} ${cf.id}  (+${cf.insertions}/-${cf.deletions})\n`,
    );
  }

  process.stdout.write('\nBlast radius (dependents that may need re-testing):\n');
  for (const cf of rep.changed) {
    const deps = rep.blastRadius.get(cf.id) ?? [];
    process.stdout.write(`  ${cf.id} -> ${deps.length} dependent(s)\n`);
    for (const d of deps) process.stdout.write(`      ${d}\n`);
  }

  process.stdout.write(
    `\nAffected set (changed + dependents): ${rep.affected.length} files\n`,
  );
  for (const a of rep.affected) process.stdout.write(`  ${a}\n`);
}

async function cmdReport(dir: string, flags: Map<string, string | boolean>): Promise<void> {
  const graph = await buildGraph(dir);
  const full = fullRepoTokens(graph);
  const depth = flagInt(flags, 'depth', 2);
  const tokenBudget = flags.has('token-budget')
    ? flagInt(flags, 'token-budget', 8000)
    : 8000;

  process.stdout.write(`Repo: ${dir}\n`);
  process.stdout.write(`Files: ${graph.nodes.size}\n`);
  process.stdout.write(`Full-repo context: ~${formatTokens(full)} tokens\n\n`);

  // Pick a representative seed: prefer an explicit --seed, else the
  // most-depended-on file (a realistic "edit a core module" scenario).
  let seedId = flagStr(flags, 'seed') ? seedToId(graph, flagStr(flags, 'seed')!) : null;
  if (!seedId) {
    const top = mostDependedOn(graph, 1)[0];
    seedId = top?.id ?? [...graph.nodes.keys()][0];
  }
  if (!seedId) {
    process.stdout.write('No files to analyze.\n');
    return;
  }

  const pack = buildPack(graph, {
    seeds: [seedId],
    depth,
    tokenBudget,
    direction: 'both',
  });

  process.stdout.write(
    `Typical pack (seed=${seedId}, depth=${depth}, budget=${formatTokens(tokenBudget)}):\n`,
  );
  process.stdout.write(`  Files included: ${pack.included.length} / ${graph.nodes.size}\n`);
  process.stdout.write(`  Pack tokens: ~${formatTokens(pack.totalTokens)}\n`);
  process.stdout.write(
    `  Tokens saved vs full repo: ${percentSaved(full, pack.totalTokens)}% ` +
      `(${formatTokens(full - pack.totalTokens)} fewer tokens)\n`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, positionals, flags } = parseArgs(argv);

  switch (command) {
    case 'index':
      await cmdIndex(requireDir(positionals));
      break;
    case 'pack':
      await cmdPack(requireDir(positionals), flags);
      break;
    case 'changed':
      await cmdChanged(requireDir(positionals), flags);
      break;
    case 'report':
      await cmdReport(requireDir(positionals), flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      break;
    case 'version':
    case '--version':
    case '-v': {
      try {
        const pkg = JSON.parse(
          readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
        );
        process.stdout.write(`rcca ${pkg.version}\n`);
      } catch {
        process.stdout.write('rcca (unknown version)\n');
      }
      break;
    }
    default:
      process.stderr.write(`rcca: unknown command "${command}"\n\n${HELP}`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`rcca: ${err?.stack ?? err}\n`);
  process.exit(1);
});
