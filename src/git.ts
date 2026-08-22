/**
 * git.ts — changed-file detection via git, with blast-radius hinting.
 *
 * Uses `git` through child_process (no library dependency). We tolerate repos
 * with no commits, dirty/clean trees, and the case where the target dir is not
 * a git repo at all — returning structured info instead of throwing.
 */

import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import { blastRadius, type RepoGraph } from './graph.js';
import { isSupportedSource } from './parser.js';

export interface ChangedFile {
  id: string; // repo-graph relative id (relative to the graph root)
  status: string; // git status letter(s): M, A, D, R, ??
  insertions: number;
  deletions: number;
}

export interface ChangedReport {
  isGitRepo: boolean;
  base: string; // what we diffed against ("HEAD", "working-tree", or "none")
  changed: ChangedFile[];
  /** Map of changed file id -> set of dependent ids (its blast radius). */
  blastRadius: Map<string, string[]>;
  /** Union of all changed files + their dependents — the suggested test/context set. */
  affected: string[];
  note?: string;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    return { ok: false, stdout: res.stdout ?? '', stderr: res.stderr ?? String(res.error ?? '') };
  }
  return { ok: true, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function isGitRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

function hasCommits(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--verify', 'HEAD']).ok;
}

/** Parse `git diff --numstat` output into a map of path -> {ins, del}. */
function parseNumstat(out: string): Map<string, { ins: number; del: number }> {
  const map = new Map<string, { ins: number; del: number }>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const ins = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
    const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
    // Handle renames "old => new" — git uses the path part for numstat.
    const path = parts.slice(2).join('\t');
    map.set(path, { ins, del });
  }
  return map;
}

/**
 * Detect changed source files relative to the graph and compute blast radius.
 * `baseRef` defaults to HEAD (diff working tree + staged against last commit).
 * Pass e.g. "origin/main" or "main...HEAD" to compare against a branch.
 */
export function changedFiles(graph: RepoGraph, baseRef = 'HEAD'): ChangedReport {
  const root = graph.root;

  if (!isGitRepo(root)) {
    return {
      isGitRepo: false,
      base: 'none',
      changed: [],
      blastRadius: new Map(),
      affected: [],
      note: 'Target directory is not inside a git repository.',
    };
  }

  // Determine the diff target. With no commits yet, diff the index/working tree.
  let nameStatusOut: string;
  let numstatOut: string;
  let base: string;

  if (hasCommits(graph.root) && baseRef === 'HEAD') {
    // Working tree + staged changes vs HEAD.
    base = 'HEAD';
    nameStatusOut = git(root, ['diff', '--name-status', 'HEAD']).stdout;
    numstatOut = git(root, ['diff', '--numstat', 'HEAD']).stdout;
  } else if (baseRef !== 'HEAD') {
    base = baseRef;
    nameStatusOut = git(root, ['diff', '--name-status', baseRef]).stdout;
    numstatOut = git(root, ['diff', '--numstat', baseRef]).stdout;
  } else {
    // No commits: everything tracked/added counts as changed.
    base = 'working-tree';
    nameStatusOut = git(root, ['status', '--porcelain']).stdout;
    numstatOut = '';
  }

  const stats = parseNumstat(numstatOut);
  const changed: ChangedFile[] = [];

  // The git repo root may be above `root`; resolve paths relative to graph root.
  const repoTop = git(root, ['rev-parse', '--show-toplevel']).stdout.trim() || root;

  const addChanged = (gitPath: string, status: string): void => {
    const abs = resolve(repoTop, gitPath);
    if (!isSupportedSource(abs)) return;
    const id = relative(root, abs).split('\\').join('/');
    // Only include files that live under the graph root.
    if (id.startsWith('..')) return;
    const stat = stats.get(gitPath) ?? { ins: 0, del: 0 };
    changed.push({ id, status, insertions: stat.ins, deletions: stat.del });
  };

  if (base === 'working-tree') {
    for (const line of nameStatusOut.split('\n')) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2).trim();
      const path = line.slice(3).trim();
      addChanged(path, status || '??');
    }
  } else {
    for (const line of nameStatusOut.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0];
      // Renames: R100\told\tnew -> take the new path.
      const path = status.startsWith('R') ? parts[2] : parts[1];
      if (path) addChanged(path, status);
    }
  }

  // Compute blast radius for each changed file using the graph.
  const radius = new Map<string, string[]>();
  const affected = new Set<string>();
  for (const cf of changed) {
    affected.add(cf.id);
    const deps = blastRadius(graph, cf.id);
    radius.set(cf.id, [...deps].sort());
    for (const d of deps) affected.add(d);
  }

  return {
    isGitRepo: true,
    base,
    changed,
    blastRadius: radius,
    affected: [...affected].sort(),
    note: changed.length === 0 ? 'No changed source files detected.' : undefined,
  };
}
