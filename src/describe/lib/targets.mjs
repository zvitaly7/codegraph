// What `describe` describes, and what it decides has changed.
//
// `collectTargets(graph, opts)` turns a loaded graph into a ranked list of
// describable items — domains, files or symbols — each carrying:
//   - `facts`:       the CHEAP, already-computed graph facts the prompt is built
//                    from (imports, importers, domain, exported symbols, ref
//                    counts). Never a file body.
//   - `outline`:     for files and symbols, the declarations WITHOUT the bodies
//                    (reused from the `outline` layer — that is the big saving).
//   - `contentHash`: sha256 over `{kind, id, facts, sources}`, where `sources`
//                    is every contributing file's own `sha256` (the one the
//                    inventory layer already stored). The outline is a pure
//                    function of the file's bytes, so hashing the bytes covers
//                    it. Same hash → the answer to the same question → reuse it.
//
// Ranking exists so `--top N` means something: domains by file count, files by
// how many files import them, symbols by cross-file reference count. Ties break
// on the id, so two runs over one cache pick the same N.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { hashFile } from '../../inventory/hasher.mjs';
import { readRepoFile } from '../../lib/file_target.mjs';
import { buildOutline } from '../../outline/lib/outline.mjs';
import {
  fileIdToPath, toFileId, domainOfFile, symbolsOfFile, referencingFiles,
  directImporters, importsOfFile, filesOfDomain,
} from '../../lib/graph_query.mjs';

/** How many entries any single fact list carries into a prompt. */
const FACT_CAP = 8;
/** Declarations kept in a file's outline before it is truncated. */
const OUTLINE_CAP = 40;

/** Accepted `--scope` values. */
export const SCOPES = ['domains', 'files', 'symbols', 'all'];

/** Default `--scope`: fewest items, highest value per call. */
export const DEFAULT_SCOPE = 'domains';

/** `--scope` value → the kinds it selects. */
const SCOPE_KINDS = {
  domains: ['domain'],
  files: ['file'],
  symbols: ['symbol'],
  all: ['domain', 'file', 'symbol'],
};

/** The kinds a scope covers, or null when the scope is not a known one. */
export function kindsForScope(scope) {
  return Object.hasOwn(SCOPE_KINDS, scope) ? SCOPE_KINDS[scope] : null;
}

// ---- hashing ------------------------------------------------------------

/** Recursively sort object keys so the hashed JSON is stable. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The content hash of a describable item: its graph facts plus the content
 * hashes of every file that feeds it.
 */
export function contentHashOf({ kind, id, facts, sources }) {
  return sha256(JSON.stringify(stable({ v: 1, kind, id, facts, sources })));
}

/**
 * A file's content hash: the `sha256` the inventory layer already recorded, or
 * — when the graph was built with `--no-hash` — computed here so a re-run can
 * still tell what changed.
 */
function fileHash(graph, repoRoot, path) {
  const fromGraph = graph.getNode(toFileId(path))?.properties?.sha256;
  if (typeof fromGraph === 'string' && fromGraph.length > 0) return fromGraph;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  return hashFile(resolve(repoRoot, path)).sha256;
}

// ---- shared readers -----------------------------------------------------

const byRankThenId = (a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Sort desc by `n`, tie-break on `name`, then cap. */
function topByCount(entries, cap = FACT_CAP) {
  return entries
    .sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, cap)
    .map(({ name, n }) => ({ name, n }));
}

/** Exported symbols of a file, with how many OTHER files reference each. */
function exportedSymbols(graph, fileId) {
  return symbolsOfFile(graph, fileId)
    .filter((s) => s.properties?.exported === true)
    .map((s) => ({
      name: s.properties?.name ?? s.id,
      kind: s.properties?.kind ?? null,
      refs: referencingFiles(graph, s.id).length,
    }));
}

/**
 * A file's outline, truncated. Returns null when the file cannot be read — a
 * description built from graph facts alone is still worth having.
 */
function outlineOf(repoRoot, path) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  const text = readRepoFile(repoRoot, path);
  if (text === null) return null;
  return buildOutline(path, text, { limit: OUTLINE_CAP });
}

// ---- per-kind targets ---------------------------------------------------

function domainTargets(graph, repoRoot) {
  return graph.byLabel('Domain').map((node) => {
    const id = node.id;
    const name = node.properties?.name ?? id.replace(/^domain:/, '');
    const fileIds = filesOfDomain(graph, id);

    const depName = (domainId) => graph.getNode(domainId)?.properties?.name ?? domainId.replace(/^domain:/, '');
    const deps = (dir, endpoint) => topByCount(
      graph.neighbors(id, { dir, type: 'DEPENDS_ON' })
        .map((e) => ({ name: depName(e[endpoint]), n: e.properties?.weight ?? 1 })),
    );

    const pkgCount = new Map();
    for (const fid of fileIds) {
      for (const pkg of importsOfFile(graph, fid).external) {
        pkgCount.set(pkg, (pkgCount.get(pkg) ?? 0) + 1);
      }
    }

    const topFiles = fileIds
      .map((fid) => ({ name: fileIdToPath(fid), n: directImporters(graph, fid).length }));

    const exports = fileIds
      .flatMap((fid) => exportedSymbols(graph, fid).map((s) => ({ ...s, path: fileIdToPath(fid) })))
      .sort((a, b) => b.refs - a.refs || (a.name < b.name ? -1 : 1))
      .slice(0, FACT_CAP)
      .map((s) => ({ name: s.name, kind: s.kind, refs: s.refs }));

    const facts = {
      name,
      domainKind: node.properties?.kind ?? null,
      files: fileIds.length,
      dependsOn: deps('out', 'to'),
      dependedOnBy: deps('in', 'from'),
      packages: topByCount([...pkgCount].map(([n, c]) => ({ name: n, n: c }))),
      topFiles: topByCount(topFiles),
      exports,
    };

    const sources = fileIds
      .map((fid) => fileIdToPath(fid))
      .sort()
      .map((path) => [path, fileHash(graph, repoRoot, path)]);

    return {
      id, kind: 'domain', name, rank: fileIds.length, facts, outline: null,
      contentHash: contentHashOf({ kind: 'domain', id, facts, sources }),
    };
  });
}

function fileTargets(graph, repoRoot, outlineFor) {
  return graph.byLabel('File')
    .map((node) => {
      const id = node.id;
      const path = node.properties?.path ?? fileIdToPath(id);
      const { internal, external } = importsOfFile(graph, id);
      const importers = directImporters(graph, id).map(fileIdToPath);
      const facts = {
        path,
        language: node.properties?.language ?? null,
        fileKind: node.properties?.kind ?? null,
        domain: domainOfFile(graph, id)?.name ?? null,
        imports: { internal: internal.slice(0, FACT_CAP), external: external.slice(0, FACT_CAP) },
        importedBy: { count: importers.length, files: importers.slice(0, FACT_CAP) },
        exports: exportedSymbols(graph, id)
          .sort((a, b) => b.refs - a.refs || (a.name < b.name ? -1 : 1))
          .slice(0, FACT_CAP),
      };
      const sources = [[path, fileHash(graph, repoRoot, path)]];
      return {
        id,
        kind: 'file',
        name: path,
        rank: importers.length,
        facts,
        outline: outlineFor(path),
        contentHash: contentHashOf({ kind: 'file', id, facts, sources }),
      };
    });
}

/** The one outline declaration that matches a symbol name, or null. */
function declarationFor(outline, name) {
  const list = outline?.declarations?.list ?? [];
  return list.find((d) => d.name === name) ?? null;
}

function symbolTargets(graph, repoRoot, outlineFor) {
  return graph.byLabel('Symbol').map((node) => {
    const id = node.id;
    const props = node.properties ?? {};
    const name = props.name ?? id.slice(id.lastIndexOf('#') + 1);
    const path = props.path ?? id.slice('sym:'.length, id.lastIndexOf('#'));
    const refFiles = referencingFiles(graph, id);
    const shortSym = (symId) => (typeof symId === 'string' && symId.startsWith('sym:')
      ? symId.slice(symId.lastIndexOf('#') + 1)
      : String(symId));

    const facts = {
      name,
      symbolKind: props.kind ?? null,
      path,
      line: props.line ?? null,
      exported: props.exported === true,
      domain: domainOfFile(graph, toFileId(path))?.name ?? null,
      referencedBy: { count: refFiles.length, files: refFiles.slice(0, FACT_CAP) },
      uses: [...new Set(graph.neighbors(id, { dir: 'out', type: 'USES' }).map((e) => shortSym(e.to)))]
        .sort().slice(0, FACT_CAP),
      usedBy: [...new Set(graph.neighbors(id, { dir: 'in', type: 'USES' }).map((e) => shortSym(e.from)))]
        .sort().slice(0, FACT_CAP),
    };
    const sources = [[path, fileHash(graph, repoRoot, path)]];
    const declaration = declarationFor(outlineFor(path), name);
    return {
      id,
      kind: 'symbol',
      name,
      rank: refFiles.length,
      facts,
      outline: declaration ? { kind: 'declaration', path, declarations: { count: 1, list: [declaration] } } : null,
      contentHash: contentHashOf({ kind: 'symbol', id, facts, sources }),
    };
  });
}

// ---- entry point --------------------------------------------------------

/**
 * Every describable item the scope selects, ranked, capped by `--top`.
 *
 * @param {object} graph a loaded graph (see ../../lib/graph_load.mjs).
 * @param {{scope?: string, top?: number, repoRoot?: string}} [opts]
 *   `repoRoot` is only needed to read outlines (files/symbols) and to hash a
 *   file the inventory layer did not hash; without it those degrade, they do
 *   not fail.
 * @returns {{targets: object[], totals: Record<string, number>}} `totals` is the
 *   count per kind BEFORE `--top`, so a caller can say what it left out.
 */
export function collectTargets(graph, { scope = 'domains', top, repoRoot } = {}) {
  const kinds = kindsForScope(scope) ?? SCOPE_KINDS.domains;
  const cap = Number.isInteger(top) && top > 0 ? top : null;

  // One parse per file, however many symbols it declares.
  const outlineCache = new Map();
  const outlineFor = (path) => {
    if (!outlineCache.has(path)) outlineCache.set(path, outlineOf(repoRoot, path));
    return outlineCache.get(path);
  };

  const targets = [];
  const totals = {};
  for (const kind of kinds) {
    const all = kind === 'domain' ? domainTargets(graph, repoRoot)
      : kind === 'file' ? fileTargets(graph, repoRoot, outlineFor)
        : symbolTargets(graph, repoRoot, outlineFor);
    totals[kind] = all.length;
    all.sort(byRankThenId);
    targets.push(...(cap === null ? all : all.slice(0, cap)));
  }
  return { targets, totals };
}
