import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  buildGraph,
  traverse,
  mostDependedOn,
  blastRadius,
  resolveImport,
  listSourceFiles,
} from '../src/graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(here, '../fixtures/sample-repo');

test('listSourceFiles finds sources and skips .d.ts / ignored dirs', () => {
  const files = listSourceFiles(SAMPLE);
  assert.ok(files.length >= 9, `expected >=9 files, got ${files.length}`);
  assert.ok(files.every((f) => !f.includes('node_modules')));
  assert.ok(files.some((f) => f.endsWith('Avatar.tsx')));
});

test('buildGraph builds a directional dependency graph', async () => {
  const g = await buildGraph(SAMPLE);

  // logger is imported by many files -> top hub.
  const logger = g.nodes.get('src/utils/logger.ts');
  assert.ok(logger, 'logger node exists');
  assert.ok(logger!.importedBy.size >= 5, `logger importedBy=${logger!.importedBy.size}`);

  // user.model.ts is a leaf: imports nothing internal.
  const model = g.nodes.get('src/models/user.model.ts');
  assert.equal(model!.imports.size, 0);
  assert.ok(model!.importedBy.size >= 2);

  // user service imports logger, validation, model, repository.
  const userSvc = g.nodes.get('src/services/user.ts');
  assert.ok(userSvc!.imports.has('src/utils/logger.ts'));
  assert.ok(userSvc!.imports.has('src/utils/validation.ts'));
  assert.ok(userSvc!.imports.has('src/models/user.model.ts'));
  assert.ok(userSvc!.imports.has('src/db/repository.ts'));

  // External (npm) imports captured separately.
  assert.ok(g.edgeCount > 0);
});

test('require() and dynamic import() resolve to internal edges', async () => {
  const g = await buildGraph(SAMPLE);
  const routes = g.nodes.get('src/api/routes.ts');
  assert.ok(routes, 'routes node exists');
  // require('../utils/logger.js') must resolve to logger.ts.
  assert.ok(routes!.imports.has('src/utils/logger.ts'));
  // dynamic import('../services/channel.js') must resolve to channel.ts.
  assert.ok(routes!.imports.has('src/services/channel.ts'));
});

test('resolveImport maps .js specifiers to .ts source and index files', () => {
  const fileSet = new Set([
    '/repo/src/a.ts',
    '/repo/src/dir/index.ts',
  ]);
  assert.equal(resolveImport('/repo/src/main.ts', './a.js', fileSet), '/repo/src/a.ts');
  assert.equal(resolveImport('/repo/src/main.ts', './a', fileSet), '/repo/src/a.ts');
  assert.equal(resolveImport('/repo/src/main.ts', './dir', fileSet), '/repo/src/dir/index.ts');
  assert.equal(resolveImport('/repo/src/main.ts', 'react', fileSet), null);
  assert.equal(resolveImport('/repo/src/main.ts', './missing', fileSet), null);
});

test('traverse: imports direction collects dependencies within depth', async () => {
  const g = await buildGraph(SAMPLE);
  // From routes, depth 1, imports-only -> direct deps only.
  const r1 = traverse(g, ['src/api/routes.ts'], 1, 'imports');
  assert.equal(r1.distances.get('src/api/routes.ts'), 0);
  assert.equal(r1.distances.get('src/services/user.ts'), 1);
  // user.model is 2 hops away, should NOT appear at depth 1.
  assert.equal(r1.distances.has('src/models/user.model.ts'), false);

  // depth 2 should now reach the model.
  const r2 = traverse(g, ['src/api/routes.ts'], 2, 'imports');
  assert.equal(r2.distances.get('src/models/user.model.ts'), 2);
});

test('traverse: importers direction collects dependents (blast radius)', async () => {
  const g = await buildGraph(SAMPLE);
  // Who depends on logger? Everything that imports it, within depth.
  const r = traverse(g, ['src/utils/logger.ts'], 1, 'importers');
  assert.ok(r.distances.get('src/services/user.ts') === 1);
  assert.ok(r.distances.get('src/db/repository.ts') === 1);
});

test('mostDependedOn ranks hubs first', async () => {
  const g = await buildGraph(SAMPLE);
  const ranked = mostDependedOn(g, 3);
  assert.equal(ranked[0].id, 'src/utils/logger.ts');
  assert.ok(ranked[0].count >= ranked[1].count);
});

test('blastRadius returns transitive dependents', async () => {
  const g = await buildGraph(SAMPLE);
  // Changing the model affects services, then routes, then index (transitively).
  const radius = blastRadius(g, 'src/models/user.model.ts');
  assert.ok(radius.has('src/services/user.ts'));
  assert.ok(radius.has('src/api/routes.ts'));
  assert.ok(radius.has('src/index.ts'));
});
