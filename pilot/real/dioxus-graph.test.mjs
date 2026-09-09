import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDioxusSplitGraph } from './dioxus-graph.mjs';

const base = `
export const __wasm_split_load_chunk_0 = makeLoad("/harness/split/chunk_0_shared.wasm", [], fusedImports, initSync);
export const __wasm_split_load_moduleChildSplit_abc_routeChildSplit0123456789abcdef0123456789abcdef = makeLoad("/harness/split/module_0_routeChildSplit0123456789abcdef0123456789abcdef.wasm", [__wasm_split_load_chunk_0], fusedImports, initSync);
export const __wasm_split_load_five_abc_InnerChild = makeLoad("/harness/split/module_1_InnerChild.wasm", [], fusedImports, initSync);
`;

test('extracts one route-owned module and its dependency-first shared chunk closure', () => {
  const graph = parseDioxusSplitGraph(base);
  assert.equal(graph.route, '/child');
  assert.equal(graph.routeModule, 'module_0_routeChildSplit0123456789abcdef0123456789abcdef.wasm');
  assert.deepEqual(graph.routes, {
    '/child': 'module_0_routeChildSplit0123456789abcdef0123456789abcdef.wasm',
  });
  assert.deepEqual(graph.dependencies, {
    'module_0_routeChildSplit0123456789abcdef0123456789abcdef.wasm': ['chunk_0_shared.wasm'],
  });
  assert.deepEqual(graph.closure, [
    'chunk_0_shared.wasm',
    'module_0_routeChildSplit0123456789abcdef0123456789abcdef.wasm',
  ]);
  assert.equal(graph.noExecution, true);
  assert.equal(graph.sourceSha256.length, 64);
});

test('fails on unresolved dependency symbols', () => {
  const invalid = base.replace('__wasm_split_load_chunk_0],', '__wasm_split_load_chunk_99],');
  assert.throws(() => parseDioxusSplitGraph(invalid), /dependency __wasm_split_load_chunk_99 is not an emitted loader/);
});

test('fails on duplicate route-module candidates instead of choosing by filename order', () => {
  const duplicate = `${base}\nexport const __wasm_split_load_moduleChildSplit_def_routeChildSplitffffffffffffffffffffffffffffffff = makeLoad("/harness/split/module_2_routeChildSplitffffffffffffffffffffffffffffffff.wasm", [], fusedImports, initSync);\n`;
  assert.throws(() => parseDioxusSplitGraph(duplicate), /expected exactly one generated route module.*found 2/);
});

test('fails on malformed dependency lists and unsafe split URLs', () => {
  assert.throws(
    () => parseDioxusSplitGraph(base.replace('[__wasm_split_load_chunk_0]', '[window.evil]')),
    /malformed dependency symbol list/,
  );
  assert.throws(
    () => parseDioxusSplitGraph(base.replace('/harness/split/chunk_0_shared.wasm', '/harness/split/../secret.wasm')),
    /noncanonical Dioxus split URL/,
  );
});

test('fails if framework output no longer exposes the expected route component', () => {
  const changed = base.replaceAll('routeChildSplit', 'routeRenamed');
  assert.throws(() => parseDioxusSplitGraph(changed), /expected exactly one generated route module.*found 0/);
});
