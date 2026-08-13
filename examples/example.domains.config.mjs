// Example domains overlay override for codegraph — a small, generic sample.
//
// By default codegraph auto-derives the domain tables from your file tree
// (each first-level directory under a src root becomes a product domain; every
// other top-level directory becomes an infra "area bucket"). Supply this file
// only when you want to name domains explicitly, merge several directories into
// one domain, or alias differently-named folders together.
//
// Wire it up from codegraph.config.mjs, e.g.:
//
//   export default { domains: './examples/example.domains.config.mjs' };
//
// or inline the same object as `domains: { CANONICAL_DOMAINS, ALIASES, ... }`.
//
// Three tables are read:
//   CANONICAL_DOMAINS : { <id>: { kind: 'product' | 'infra' } }
//                       every domain that may own files; 'unassigned' (infra) is
//                       always added for you if omitted.
//   ALIASES           : { <lowercased path segment>: <canonical domain id> }
//                       maps a folder name under a src root onto a domain — use
//                       it to fold synonyms (e.g. 'basket' → cart) together.
//   AREA_BUCKETS      : [ [pathPrefix, domainId], ... ]
//                       ordered prefix rules for files outside the src roots;
//                       the first matching prefix wins.

export const CANONICAL_DOMAINS = {
  cart: { kind: 'product' },
  checkout: { kind: 'product' },
  search: { kind: 'product' },
  tooling: { kind: 'infra' },
  docs: { kind: 'infra' },
  unassigned: { kind: 'infra' },
};

export const ALIASES = {
  cart: 'cart',
  basket: 'cart',        // 'src/basket/*' is folded into the cart domain
  checkout: 'checkout',
  payment: 'checkout',
  search: 'search',
  discovery: 'search',
};

export const AREA_BUCKETS = [
  ['scripts', 'tooling'],
  ['tools', 'tooling'],
  ['docs', 'docs'],
];

export default { CANONICAL_DOMAINS, ALIASES, AREA_BUCKETS };
