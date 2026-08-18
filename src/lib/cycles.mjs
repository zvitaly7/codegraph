// Circular dependencies — stub. Behaviour lands next.

export const SCOPES = ['file', 'domain', 'both'];
export const DEFAULT_LIMIT = 20;

export function findCycles() {
  return { cycles: [], selfLoops: [], nodes: 0, edges: 0 };
}

export function fileCycles() {
  return { scope: 'file', total: 0, returned: 0, truncated: false, selfLoops: [], cycles: [] };
}

export function domainCycles() {
  return { scope: 'domain', total: 0, returned: 0, truncated: false, selfLoops: [], cycles: [] };
}

export function buildCycles() {
  return { scope: 'both', total: 0 };
}

export function renderCycles() {
  return '';
}
