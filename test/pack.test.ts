import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildGraph } from '../src/graph.js';
import { buildPack, renderPack, fullRepoTokens } from '../src/pack.js';
import { estimateTokens, percentSaved, countTokens, setTokenizer } from '../src/tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '../fixtures/sample-repo');

test('estimateTokens approximates chars/4', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2); // ceil(5/4)
});

test('percentSaved math', () => {
  assert.equal(percentSaved(1000, 250), 75);
  assert.equal(percentSaved(0, 0), 0);
});

test('setTokenizer swaps the active counter and can be restored', () => {
  const prev = setTokenizer(() => 999);
  assert.equal(countTokens('anything'), 999);
  setTokenizer(prev);
  assert.equal(countTokens('abcd'), 1);
});

test('buildPack includes the seed and its dependencies', async () => {
  const g = await buildGraph(SAMPLE);
  const pack = buildPack(g, { seeds: ['src/services/user.ts'], depth: 2, direction: 'imports' });
  const ids = pack.included.map((f) => f.id);
  assert.ok(ids.includes('src/services/user.ts'));
  assert.ok(ids.includes('src/utils/logger.ts'));
  assert.ok(ids.includes('src/models/user.model.ts'));
  // Seed always at distance 0 and first.
  assert.equal(pack.included[0].id, 'src/services/user.ts');
  assert.equal(pack.included[0].distance, 0);
});

test('buildPack respects the token budget and drops the right files', async () => {
  const g = await buildGraph(SAMPLE);
  // Very small budget: only the seed (always kept) + maybe nothing else.
  const tiny = buildPack(g, {
    seeds: ['src/services/user.ts'],
    depth: 2,
    direction: 'both',
    tokenBudget: 1,
  });
  // Seed is always included even though it exceeds budget.
  assert.ok(tiny.included.some((f) => f.id === 'src/services/user.ts'));
  // Everything non-seed is dropped under a 1-token budget.
  assert.ok(tiny.dropped.length > 0);
  assert.ok(tiny.dropped.every((f) => f.distance > 0));

  // A generous budget includes strictly more files than the tiny one.
  const big = buildPack(g, {
    seeds: ['src/services/user.ts'],
    depth: 2,
    direction: 'both',
    tokenBudget: 100000,
  });
  assert.ok(big.included.length > tiny.included.length);
  assert.equal(big.dropped.length, 0);
});

test('buildPack never exceeds the budget for non-seed inclusions', async () => {
  const g = await buildGraph(SAMPLE);
  const budget = 200;
  const pack = buildPack(g, {
    seeds: ['src/utils/logger.ts'],
    depth: 3,
    direction: 'both',
    tokenBudget: budget,
  });
  // Sum of non-seed tokens must be <= budget.
  const nonSeed = pack.included.filter((f) => f.distance > 0);
  const used = nonSeed.reduce((s, f) => s + f.tokens, 0);
  assert.ok(used <= budget, `used ${used} > budget ${budget}`);
});

test('buildPack orders closer files before farther ones', async () => {
  const g = await buildGraph(SAMPLE);
  const pack = buildPack(g, { seeds: ['src/index.ts'], depth: 3, direction: 'imports' });
  const distances = pack.included.map((f) => f.distance);
  // Distances should be non-decreasing (greedy closest-first).
  for (let i = 1; i < distances.length; i++) {
    assert.ok(distances[i] >= distances[i - 1], `not sorted at ${i}: ${distances}`);
  }
});

test('renderPack produces a fenced artifact with file headers', async () => {
  const g = await buildGraph(SAMPLE);
  const pack = buildPack(g, { seeds: ['src/services/user.ts'], depth: 1, direction: 'imports' });
  const out = renderPack(pack);
  assert.ok(out.includes('# Context Pack'));
  assert.ok(out.includes('===== FILE: src/services/user.ts'));
  assert.ok(out.includes('class UserService'));
});

test('a typical pack is much smaller than the full repo', async () => {
  const g = await buildGraph(SAMPLE);
  const full = fullRepoTokens(g);
  const pack = buildPack(g, {
    seeds: ['src/models/user.model.ts'],
    depth: 1,
    direction: 'imports',
    tokenBudget: 8000,
  });
  assert.ok(pack.totalTokens < full);
  assert.ok(percentSaved(full, pack.totalTokens) > 0);
});
