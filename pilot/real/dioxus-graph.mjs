import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const DECLARATION = /^export const (?<symbol>__wasm_split_load_[A-Za-z0-9_]+)\s*=\s*makeLoad\("(?<url>[^"\r\n]+\.wasm)",\s*\[(?<deps>[^\]]*)\],\s*fusedImports(?:,\s*initSync)?\);\s*$/gmu;
const SYMBOL = /^__wasm_split_load_[A-Za-z0-9_]+$/u;
const FILE = /^(?:chunk|module)_\d+_[A-Za-z0-9_]+\.wasm$/u;

function fail(message) {
  throw new Error(`Dioxus split graph admission failed: ${message}`);
}

function parseDependencies(raw, owner) {
  const text = raw.trim();
  if (!text) return [];
  const values = text.split(',').map((value) => value.trim());
  if (values.some((value) => !SYMBOL.test(value))) fail(`${owner}: malformed dependency symbol list`);
  if (new Set(values).size !== values.length) fail(`${owner}: duplicate dependency symbol`);
  return values;
}

function relativeSplitPath(raw, symbol) {
  if (!raw.startsWith('/harness/split/') || raw.includes('?') || raw.includes('#') || raw.includes('..')) {
    fail(`${symbol}: noncanonical Dioxus split URL ${raw}`);
  }
  const name = basename(raw);
  if (!FILE.test(name) || `/harness/split/${name}` !== raw) fail(`${symbol}: unsafe split asset URL ${raw}`);
  return name;
}

export function parseDioxusSplitGraph(source, {
  route = '/child',
  routeComponent = 'ChildSplit',
} = {}) {
  if (typeof source !== 'string' || source.length === 0) fail('generated __wasm_split.js is empty');
  if (!route.startsWith('/') || route.includes('?') || route.includes('#') || route.includes('..')) fail('route is not canonical');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(routeComponent)) fail('route component identifier is invalid');

  const declarations = [];
  const bySymbol = new Map();
  const byPath = new Map();
  for (const match of source.matchAll(DECLARATION)) {
    const { symbol, url, deps } = match.groups;
    const path = relativeSplitPath(url, symbol);
    if (bySymbol.has(symbol)) fail(`duplicate loader symbol ${symbol}`);
    if (byPath.has(path)) fail(`duplicate split asset path ${path}`);
    const declaration = Object.freeze({
      symbol,
      path,
      dependencies: Object.freeze(parseDependencies(deps, symbol)),
    });
    declarations.push(declaration);
    bySymbol.set(symbol, declaration);
    byPath.set(path, declaration);
  }
  if (declarations.length === 0) fail('no emitted makeLoad declarations found');

  for (const declaration of declarations) {
    for (const dependency of declaration.dependencies) {
      const target = bySymbol.get(dependency);
      if (!target) fail(`${declaration.symbol}: dependency ${dependency} is not an emitted loader`);
      if (!target.path.startsWith('chunk_')) fail(`${declaration.symbol}: dependency ${dependency} is not a shared chunk loader`);
    }
  }

  const escaped = routeComponent.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const routeModulePattern = new RegExp(`^module_\\d+_route${escaped}[0-9a-f]+\\.wasm$`, 'u');
  const candidates = declarations.filter((declaration) => routeModulePattern.test(declaration.path));
  if (candidates.length !== 1) {
    fail(`expected exactly one generated route module for ${routeComponent}; found ${candidates.length}`);
  }
  const routeModule = candidates[0];

  const closure = [];
  const seen = new Set();
  const visit = (declaration) => {
    if (seen.has(declaration.symbol)) return;
    seen.add(declaration.symbol);
    for (const dependency of declaration.dependencies) visit(bySymbol.get(dependency));
    closure.push(declaration.path);
  };
  visit(routeModule);

  const dependencies = {};
  for (const declaration of declarations) {
    if (!seen.has(declaration.symbol) || declaration.dependencies.length === 0) continue;
    dependencies[declaration.path] = declaration.dependencies.map((symbol) => bySymbol.get(symbol).path);
  }

  return Object.freeze({
    schema: 'ores-wasm-loaders.dioxus-split-graph/v1',
    route,
    routeComponent,
    routeModule: routeModule.path,
    routes: Object.freeze({ [route]: routeModule.path }),
    dependencies: Object.freeze(dependencies),
    closure: Object.freeze(closure),
    declarations: Object.freeze(declarations),
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    noExecution: true,
  });
}

if (process.env.DIOXUS_SPLIT_GLUE) {
  const source = await readFile(process.env.DIOXUS_SPLIT_GLUE, 'utf8');
  const graph = parseDioxusSplitGraph(source, {
    route: process.env.DIOXUS_ROUTE || '/child',
    routeComponent: process.env.DIOXUS_ROUTE_COMPONENT || 'ChildSplit',
  });
  process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
}
