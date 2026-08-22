import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSource,
  parseWithRegex,
  stripComments,
  _disableTypeScriptForTesting,
} from '../src/parser.js';

test('parseSource extracts all import forms via TS compiler', async () => {
  const code = `
    import { a } from './a';
    import b from "./b.js";
    import type { C } from './c';
    export { d } from './d';
    export * from './e';
    const f = require('./f');
    const g = await import('./g');
    import bare from 'rocketchat-core';
  `;
  const { imports, strategy } = await parseSource('x.ts', code);
  assert.equal(strategy, 'typescript');
  const specs = imports.map((i) => i.specifier).sort();
  assert.deepEqual(specs, [
    './a',
    './b.js',
    './c',
    './d',
    './e',
    './f',
    './g',
    'rocketchat-core',
  ]);

  const kinds = new Map(imports.map((i) => [i.specifier, i.kind]));
  assert.equal(kinds.get('./f'), 'require');
  assert.equal(kinds.get('./g'), 'dynamic');
  assert.equal(kinds.get('./d'), 'export-from');
  assert.equal(kinds.get('./e'), 'export-from');
});

test('regex fallback finds the common import forms', () => {
  const code = `
    import { a } from './a';
    import './side-effect';
    export * from './e';
    const f = require("./f");
    const g = import('./g');
  `;
  const imports = parseWithRegex(code);
  const specs = imports.map((i) => i.specifier).sort();
  assert.ok(specs.includes('./a'));
  assert.ok(specs.includes('./side-effect'));
  assert.ok(specs.includes('./e'));
  assert.ok(specs.includes('./f'));
  assert.ok(specs.includes('./g'));
});

test('parseSource falls back to regex when TS is disabled', async () => {
  _disableTypeScriptForTesting();
  const code = `import { a } from './a';\nconst b = require('./b');`;
  const { imports, strategy } = await parseSource('x.ts', code);
  assert.equal(strategy, 'regex');
  const specs = imports.map((i) => i.specifier).sort();
  assert.deepEqual(specs, ['./a', './b']);
});

test('stripComments ignores commented-out imports but keeps strings', () => {
  const code = `
    // import { ghost } from './ghost';
    /* import { also } from './also'; */
    import { real } from './real';
    const url = "http://not-a-comment";
  `;
  const stripped = stripComments(code);
  assert.ok(!stripped.includes('ghost'));
  assert.ok(!stripped.includes('also'));
  assert.ok(stripped.includes('./real'));
  assert.ok(stripped.includes('http://not-a-comment'));

  const imports = parseWithRegex(code).map((i) => i.specifier);
  assert.deepEqual(imports, ['./real']);
});
