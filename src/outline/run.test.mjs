import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './run.mjs';

const CART = `import { store } from './store';

/** The cart screen. */
export function Cart(props: Props): JSX.Element {
  const total = props.items.length;
  return null as unknown as JSX.Element;
}

const LOCAL = 1;
`;

function seedRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'lg-outline-cli-'));
  mkdirSync(join(repo, 'src', 'ui'), { recursive: true });
  mkdirSync(join(repo, 'src', 'checkout'), { recursive: true });
  writeFileSync(join(repo, 'src', 'ui', 'Cart.tsx'), CART);
  writeFileSync(join(repo, 'src', 'checkout', 'Cart.tsx'), 'export const other = 1;\n');
  writeFileSync(join(repo, 'src', 'util.ts'), 'export function util(): void {}\n');
  writeFileSync(join(repo, 'notes.md'), '# notes\n');
  return repo;
}

let repo;
let out;
let err;
beforeEach(() => {
  repo = seedRepo();
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((s) => out.push(String(s)));
  vi.spyOn(console, 'error').mockImplementation((s) => err.push(String(s)));
});
afterEach(() => vi.restoreAllMocks());

const stdout = () => out.join('\n');

describe('outline CLI', () => {
  it('prints a file skeleton with no bodies and exits 0', async () => {
    const code = await run(['src/ui/Cart.tsx', '--repo-root', repo]);
    expect(code).toBe(0);
    expect(stdout()).toContain('OUTLINE src/ui/Cart.tsx');
    expect(stdout()).toContain("imports (1): ./store");
    expect(stdout()).toContain('export function Cart(props: Props): JSX.Element');
    expect(stdout()).toContain('— The cart screen.');
    expect(stdout()).not.toContain('props.items.length');
  });

  it('resolves a unique path suffix', async () => {
    expect(await run(['util.ts', '--repo-root', repo])).toBe(0);
    expect(stdout()).toContain('OUTLINE src/util.ts');
  });

  it('works with no graph cache present at all', async () => {
    const code = await run(['src/util.ts', '--repo-root', repo]);
    expect(code).toBe(0);
    expect(err.join('\n')).toBe('');
  });

  it('--json emits the structured object', async () => {
    const code = await run(['src/ui/Cart.tsx', '--repo-root', repo, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed).toMatchObject({ kind: 'outline', path: 'src/ui/Cart.tsx' });
    expect(parsed.declarations.list[0]).toMatchObject({ name: 'Cart', kind: 'function', exported: true });
  });

  it('lists candidates and still exits 0 on an ambiguous target', async () => {
    const code = await run(['Cart.tsx', '--repo-root', repo]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/ambiguous/i);
    expect(stdout()).toContain('src/ui/Cart.tsx');
    expect(stdout()).toContain('src/checkout/Cart.tsx');
  });

  it('reports a miss without failing the run', async () => {
    const code = await run(['definitely-not-here.ts', '--repo-root', repo]);
    expect(code).toBe(0);
    expect(stdout()).toMatch(/no file matching/i);
  });

  it('honors --limit and marks the truncation', async () => {
    const code = await run(['src/ui/Cart.tsx', '--repo-root', repo, '--limit', '1', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.declarations.count).toBe(2);
    expect(parsed.declarations.list).toHaveLength(1);
    expect(parsed.declarations.truncated).toBe(true);
  });

  it('exits 2 without a target', async () => {
    expect(await run(['--repo-root', repo])).toBe(2);
    expect(err.join('\n')).toMatch(/file/);
  });

  it('exits 2 on a bad --limit', async () => {
    expect(await run(['src/util.ts', '--repo-root', repo, '--limit', 'lots'])).toBe(2);
  });

  it('exits 2 on a file the TS parser does not handle', async () => {
    expect(await run(['notes.md', '--repo-root', repo])).toBe(2);
    expect(err.join('\n')).toMatch(/not a JS\/TS source file/);
  });
});
