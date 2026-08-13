import { describe, it, expect } from 'vitest';
import { classify, getExtension } from './classify.mjs';

describe('getExtension', () => {
  it('handles compound and dotfile cases', () => {
    expect(getExtension('a.JS')).toBe('.js');
    expect(getExtension('types.d.ts')).toBe('.d.ts');
    expect(getExtension('bundle.tar.gz')).toBe('.tar.gz');
    expect(getExtension('Makefile')).toBe('');
    expect(getExtension('.gitignore')).toBe('');
    expect(getExtension('a.min.js')).toBe('.js');
  });
});

describe('classify language', () => {
  it('maps common code + text extensions', () => {
    expect(classify('src/a.ts').language).toBe('TypeScript');
    expect(classify('src/a.tsx').language).toBe('TypeScript');
    expect(classify('src/a.d.ts').language).toBe('TypeScript');
    expect(classify('src/a.mjs').language).toBe('JavaScript');
    expect(classify('src/a.py').language).toBe('Python');
    expect(classify('data.json').language).toBe('JSON');
    expect(classify('README.md').language).toBe('Markdown');
    expect(classify('style.scss').language).toBe('CSS');
    expect(classify('page.html').language).toBe('HTML');
    expect(classify('ci.yaml').language).toBe('YAML');
    expect(classify('logo.png').language).toBe('Binary');
  });
});

describe('classify kind', () => {
  it('lockfiles', () => {
    expect(classify('package-lock.json').kind).toBe('lockfile');
    expect(classify('yarn.lock').kind).toBe('lockfile');
    expect(classify('pnpm-lock.yaml').kind).toBe('lockfile');
  });
  it('tests', () => {
    expect(classify('src/a.test.ts').kind).toBe('test');
    expect(classify('src/a.spec.js').kind).toBe('test');
    expect(classify('tests/helper.ts').kind).toBe('test');
  });
  it('assets win over tests even under tests/', () => {
    expect(classify('tests/fixtures/logo.png').kind).toBe('asset');
    expect(classify('assets/font.woff2').kind).toBe('asset');
  });
  it('docs, config, code', () => {
    expect(classify('docs/guide.md').kind).toBe('doc');
    expect(classify('tsconfig.json').kind).toBe('config');
    expect(classify('package.json').kind).toBe('config');
    expect(classify('config/app.yaml').kind).toBe('config');
    expect(classify('src/index.ts').kind).toBe('code');
  });
  it('a data json under tests/ is not a test (not code)', () => {
    expect(classify('tests/fixtures/data.json').kind).not.toBe('test');
  });
});

describe('classify trust', () => {
  it('doc for markdown, asset for assets, else code', () => {
    expect(classify('README.md').trust).toBe('doc');
    expect(classify('logo.png').trust).toBe('asset');
    expect(classify('font.ttf').trust).toBe('asset');
    expect(classify('src/a.ts').trust).toBe('code');
    expect(classify('package-lock.json').trust).toBe('code');
    expect(classify('tsconfig.json').trust).toBe('code');
  });
});

describe('classify isBinary / isGenerated', () => {
  it('isBinary', () => {
    expect(classify('a.png').isBinary).toBe(true);
    expect(classify('a.woff2').isBinary).toBe(true);
    expect(classify('a.mp4').isBinary).toBe(true);
    expect(classify('a.zip').isBinary).toBe(true);
    expect(classify('a.ts').isBinary).toBe(false);
    expect(classify('a.svg').isBinary).toBe(false); // svg is text
  });
  it('isGenerated', () => {
    expect(classify('yarn.lock').isGenerated).toBe(true);
    expect(classify('app.min.js').isGenerated).toBe(true);
    expect(classify('app.js.map').isGenerated).toBe(true);
    expect(classify('src/a.ts').isGenerated).toBe(false);
  });
});
