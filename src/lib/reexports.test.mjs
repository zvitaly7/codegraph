import { describe, it, expect } from 'vitest';
import { extractReexports, exportAliases, entryReachableSymbols } from './reexports.mjs';

describe('extractReexports — the five re-export forms', () => {
  it('named: `export { a, b } from` carries both declared names', () => {
    expect(extractReexports('src/index.ts', "export { a, b } from './x';")).toEqual([
      {
        specifier: './x',
        kind: 'named',
        names: [{ exported: 'a', declared: 'a' }, { exported: 'b', declared: 'b' }],
      },
    ]);
  });

  it('renamed: `export { a as b } from` keeps the DECLARED name a', () => {
    expect(extractReexports('src/index.ts', "export { a as b } from './x';")).toEqual([
      { specifier: './x', kind: 'named', names: [{ exported: 'b', declared: 'a' }] },
    ]);
  });

  it('`export { default as Foo } from` declares `default` in the target', () => {
    expect(extractReexports('src/index.ts', "export { default as Foo } from './x';")).toEqual([
      { specifier: './x', kind: 'named', names: [{ exported: 'Foo', declared: 'default' }] },
    ]);
  });

  it('star: `export * from` carries no names', () => {
    expect(extractReexports('src/index.ts', "export * from './x';")).toEqual([
      { specifier: './x', kind: 'star', names: [] },
    ]);
  });

  it('namespace: `export * as ns from` records the namespace name', () => {
    expect(extractReexports('src/index.ts', "export * as ns from './x';")).toEqual([
      { specifier: './x', kind: 'namespace', names: [{ exported: 'ns', declared: null }] },
    ]);
  });

  it('reports several statements in source order, and skips non-re-exports', () => {
    const text = [
      "import { unused } from './dep';",
      'export const local = 1;',
      'export { local };',
      "export { a } from './x';",
      "export * from './y';",
    ].join('\n');
    expect(extractReexports('src/index.ts', text)).toEqual([
      { specifier: './x', kind: 'named', names: [{ exported: 'a', declared: 'a' }] },
      { specifier: './y', kind: 'star', names: [] },
    ]);
  });

  it('survives unparseable input without throwing', () => {
    expect(extractReexports('src/index.ts', 'export { from from from')).toEqual([]);
  });
});

describe('exportAliases — outside name → declared name, where they differ', () => {
  it('`export default function foo` exposes foo as `default`', () => {
    expect([...exportAliases('a.ts', 'export default function foo() {}')])
      .toEqual([['default', 'foo']]);
  });

  it('`export default class Foo` exposes Foo as `default`', () => {
    expect([...exportAliases('a.ts', 'export default class Foo {}')])
      .toEqual([['default', 'Foo']]);
  });

  it('`export default <ident>` exposes that declaration as `default`', () => {
    expect([...exportAliases('a.ts', 'const foo = 1;\nexport default foo;')])
      .toEqual([['default', 'foo']]);
  });

  it('a local `export { a as b }` clause maps b back to a', () => {
    expect([...exportAliases('a.ts', 'const a = 1;\nexport { a as b };')])
      .toEqual([['b', 'a']]);
  });

  it('identity exports produce no entries', () => {
    expect([...exportAliases('a.ts', 'export const a = 1;\nexport function b() {}')]).toEqual([]);
  });

  it('a re-export `export { a as b } from` is NOT a local alias', () => {
    expect([...exportAliases('a.ts', "export { a as b } from './x';")]).toEqual([]);
  });
});

// A tiny in-memory repo: `files` maps a path to its source text, `exported`
// maps a path to the names the symbols layer knows it declares AND exports.
function reach(files, exported, entryPoints) {
  return entryReachableSymbols({
    entryPoints,
    readSource: (p) => files[p] ?? null,
    resolveSpecifier: (fromPath, spec) => {
      // Only enough resolution for a test: './x' relative to the from-file's dir.
      const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
      const bare = spec.replace(/^\.\//, '');
      for (const cand of [`${dir}/${bare}`, bare]) {
        const norm = cand.replace(/^\//, '');
        for (const suffix of ['', '.ts', '.js', '/index.ts']) {
          if (files[norm + suffix] !== undefined) return norm + suffix;
        }
      }
      return null;
    },
    exportedNamesOf: (p) => new Set(exported[p] ?? []),
  });
}

describe('entryReachableSymbols', () => {
  it('a direct named re-export reaches the declaring file', () => {
    const found = reach(
      { 'src/index.ts': "export { renderCart } from './cart';", 'src/cart.ts': 'export const renderCart = () => 1;' },
      { 'src/cart.ts': ['renderCart'] },
      ['src/index.ts'],
    );
    expect([...found.keys()]).toEqual(['sym:src/cart.ts#renderCart']);
    expect(found.get('sym:src/cart.ts#renderCart')).toEqual({ entryPoint: 'src/index.ts', hops: 1 });
  });

  it('follows a chain two hops deep and reports the hop count', () => {
    const found = reach(
      {
        'src/index.ts': "export { deep } from './feature';",
        'src/feature/index.ts': "export { deep } from './impl';",
        'src/feature/impl.ts': 'export const deep = () => 1;',
      },
      { 'src/feature/impl.ts': ['deep'] },
      ['src/index.ts'],
    );
    expect(found.get('sym:src/feature/impl.ts#deep')).toEqual({ entryPoint: 'src/index.ts', hops: 2 });
  });

  it('`export * from` carries every export of the target', () => {
    const found = reach(
      { 'src/index.ts': "export * from './lib';", 'src/lib.ts': 'export const a = 1;\nexport const b = 2;' },
      { 'src/lib.ts': ['a', 'b'] },
      ['src/index.ts'],
    );
    expect([...found.keys()].sort()).toEqual(['sym:src/lib.ts#a', 'sym:src/lib.ts#b']);
  });

  it('a renamed re-export reaches the DECLARED name, not the exported one', () => {
    const found = reach(
      { 'src/index.ts': "export { internalName as PublicName } from './lib';", 'src/lib.ts': 'export const internalName = 1;' },
      { 'src/lib.ts': ['internalName'] },
      ['src/index.ts'],
    );
    expect([...found.keys()]).toEqual(['sym:src/lib.ts#internalName']);
  });

  it('`export { default as Foo } from` reaches the real declaration behind `default`', () => {
    const found = reach(
      { 'src/index.ts': "export { default as Widget } from './widget';", 'src/widget.ts': 'export default function realWidget() {}' },
      { 'src/widget.ts': ['realWidget'] },
      ['src/index.ts'],
    );
    expect([...found.keys()]).toEqual(['sym:src/widget.ts#realWidget']);
  });

  it('`export * as ns from` exposes everything in the namespace', () => {
    const found = reach(
      { 'src/index.ts': "export * as helpers from './lib';", 'src/lib.ts': 'export const a = 1;\nexport const b = 2;' },
      { 'src/lib.ts': ['a', 'b'] },
      ['src/index.ts'],
    );
    expect([...found.keys()].sort()).toEqual(['sym:src/lib.ts#a', 'sym:src/lib.ts#b']);
  });

  it('terminates on a re-export cycle instead of hanging', () => {
    const found = reach(
      {
        'src/index.ts': "export * from './a';",
        'src/a.ts': "export * from './b';\nexport const fromA = 1;",
        'src/b.ts': "export * from './a';\nexport const fromB = 2;",
      },
      { 'src/a.ts': ['fromA'], 'src/b.ts': ['fromB'] },
      ['src/index.ts'],
    );
    expect([...found.keys()].sort()).toEqual(['sym:src/a.ts#fromA', 'sym:src/b.ts#fromB']);
  });

  it('terminates on a NAMED re-export cycle too', () => {
    const found = reach(
      { 'src/index.ts': "export { x } from './a';", 'src/a.ts': "export { x } from './b';", 'src/b.ts': "export { x } from './a';" },
      {},
      ['src/index.ts'],
    );
    expect([...found.keys()]).toEqual([]);
  });

  it('does not walk a barrel that is not an entry point', () => {
    const found = reach(
      { 'src/barrel.ts': "export { hidden } from './impl';", 'src/impl.ts': 'export const hidden = 1;' },
      { 'src/impl.ts': ['hidden'] },
      [], // no entry points at all
    );
    expect([...found.keys()]).toEqual([]);
  });

  it('ignores a specifier that resolves to nothing in the repo', () => {
    const found = reach(
      { 'src/index.ts': "export { chunk } from 'lodash';" },
      {},
      ['src/index.ts'],
    );
    expect([...found.keys()]).toEqual([]);
  });

  it('an entry point that re-exports nothing reaches nothing', () => {
    const found = reach(
      { 'src/index.ts': 'export const mount = () => 1;' },
      { 'src/index.ts': ['mount'] },
      ['src/index.ts'],
    );
    expect([...found.keys()]).toEqual([]);
  });

  it('is deterministic in attribution when two entry points reach the same symbol', () => {
    const files = {
      'src/a.ts': "export { shared } from './impl';",
      'src/z.ts': "export { shared } from './impl';",
      'src/impl.ts': 'export const shared = 1;',
    };
    const exported = { 'src/impl.ts': ['shared'] };
    const first = reach(files, exported, ['src/a.ts', 'src/z.ts']);
    const second = reach(files, exported, ['src/z.ts', 'src/a.ts']);
    expect(first.get('sym:src/impl.ts#shared')).toEqual(second.get('sym:src/impl.ts#shared'));
  });
});
