// One TypeScript `Program`, shared by the two layers that need one.
//
// `references` (file→symbol) and `usages` (symbol→symbol) both type-check the
// WHOLE repo, and each used to call `ts.createProgram` for itself — parsing,
// binding and resolving every source file twice per `regenerate`. They ask the
// same question of the same files, so the second build is pure waste.
//
// The orchestrator creates one cache and hands it to both layers. Each layer
// still computes its own root file set and compiler options exactly as it did
// standalone, then asks the cache for a program. THE CACHE ONLY HANDS BACK A
// PROGRAM WHEN THE REQUEST IS IDENTICAL — same kind, same roots, same options.
// Anything else (a different `--max-files` cap on one layer, a tsconfig that
// resolved differently, one layer full and the other incremental) misses, and
// the layer gets its own program. Sharing the wrong program would silently
// analyse the wrong file set, which is far worse than spending the 400ms.
//
// A layer given NO cache — `loregraph references` run on its own — behaves
// exactly as before: it builds its own program and nothing here is involved.

import ts from 'typescript';

/** Stable JSON: object keys sorted, so key ORDER can never change a key. */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/**
 * The identity of a program request. Two requests share a program only when
 * this string matches exactly.
 *
 * @param {{kind: string, rootNames: string[], options: object, extra?: object}} req
 */
export function programKey({ kind, rootNames, options, extra }) {
  return stable({
    kind,
    // Sorted, because that is the order the program is actually built with.
    rootNames: [...rootNames].sort(),
    options,
    extra: extra ?? null,
  });
}

/**
 * The whole-repo program the extractors resolve against — built exactly the way
 * `extractReferences` / `extractUsages` build one for themselves when handed
 * none, so a shared program is not merely equivalent but identical.
 */
export function buildProgram({ rootNames, options }) {
  return ts.createProgram([...rootNames].sort(), options);
}

/**
 * A single-slot program cache.
 *
 * Single-slot on purpose: within one `regenerate` the two heavy layers either
 * agree (one program, reused) or they don't (two programs, and holding on to
 * the first would only waste memory). Ask for a different program and the
 * previous one is dropped.
 *
 * @returns {{get: Function, clear: Function, stats: Function}}
 */
export function createProgramCache() {
  let key = null;
  let program = null;
  let builds = 0;
  let hits = 0;

  return {
    /**
     * The program for `request`, built by `build()` on a miss.
     *
     * @param {{kind: string, rootNames: string[], options: object, extra?: object}} request
     * @param {() => import('typescript').Program} build
     * @returns {{program: import('typescript').Program, shared: boolean}}
     */
    get(request, build) {
      const k = programKey(request);
      if (program !== null && key === k) {
        hits += 1;
        return { program, shared: true };
      }
      program = build();
      key = k;
      builds += 1;
      return { program, shared: false };
    },

    /** Drop the program so the rest of the pipeline is not holding a whole repo. */
    clear() {
      key = null;
      program = null;
    },

    /** `{ builds, hits }` — how many programs were built and how many reused. */
    stats() {
      return { builds, hits };
    },
  };
}
