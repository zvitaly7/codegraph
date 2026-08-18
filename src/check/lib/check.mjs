// `loregraph check` rule engine — stub. Behaviour lands next.

export const RULE_KEYS = ['noCycles', 'maxDeadExports', 'minResolutionRate', 'domainRules'];
export const DEFAULT_MAX_OFFENDERS = 10;

export function unknownRuleKeys() {
  return [];
}

export function missingPrerequisites() {
  return [];
}

export function evaluateCheck() {
  return { configured: false, ok: true, counts: { evaluated: 0, passed: 0, failed: 0 }, rules: [] };
}

export function renderCheck() {
  return '';
}
