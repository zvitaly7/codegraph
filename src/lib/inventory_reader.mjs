// Read the Layer-1 inventory and select the source files the imports layer
// should analyze: TypeScript / JavaScript files whose kind is real code or a
// test (assets, docs, lockfiles and config are excluded).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE_LANGUAGES = new Set(['TypeScript', 'JavaScript']);
const SOURCE_KINDS = new Set(['code', 'test']);

/** @param {{language?:string, kind?:string}} row */
export function isAnalyzableSource(row) {
  return SOURCE_LANGUAGES.has(row?.language) && SOURCE_KINDS.has(row?.kind);
}

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * @param {string} inventoryDir directory holding files.jsonl / manifest.json.
 * @returns {Array<{id:string, path:string, language:string, kind:string}>}
 */
export function readInventorySources(inventoryDir) {
  return readJsonl(join(inventoryDir, 'files.jsonl')).filter(isAnalyzableSource);
}

/** @param {string} inventoryDir @returns {object} parsed manifest.json */
export function readInventoryManifest(inventoryDir) {
  return JSON.parse(readFileSync(join(inventoryDir, 'manifest.json'), 'utf8'));
}
