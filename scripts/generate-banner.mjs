// Generates the README banners in docs/images/ — four files: {light,dark} x {en,ru}.
// Run with `node scripts/generate-banner.mjs` after changing the wordmark, palette or tagline.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'images');

const THEMES = {
  light: {
    bg1: '#FFFFFF',
    bg2: '#EAF1FB',
    glow: '#2563EB',
    glowOpacity: 0.10,
    edge: '#C7D6EA',
    text: '#0B1220',
    muted: '#5B6B82',
    chip: '#64748B',
    blue: '#2563EB',
    teal: '#0D9488',
    purple: '#7C3AED',
    orange: '#EA580C',
    green: '#16A34A',
    nodeStroke: '#FFFFFF',
  },
  dark: {
    bg1: '#0A0F1C',
    bg2: '#111B2E',
    glow: '#3B82F6',
    glowOpacity: 0.22,
    edge: '#26364F',
    text: '#F1F6FC',
    muted: '#9BB0C9',
    chip: '#7C93AE',
    blue: '#60A5FA',
    teal: '#2DD4BF',
    purple: '#C084FC',
    orange: '#FB923C',
    green: '#4ADE80',
    nodeStroke: '#0A0F1C',
  },
};

// Decorative node clusters. Kept out of the central band (x 300..980, y 90..330)
// so nothing ever collides with the wordmark, whatever font the renderer picks.
const LEFT = [
  { x: 64, y: 96, r: 7, c: 'blue' },
  { x: 148, y: 58, r: 5, c: 'teal' },
  { x: 152, y: 152, r: 9, c: 'purple' },
  { x: 58, y: 214, r: 5, c: 'green' },
  { x: 186, y: 244, r: 7, c: 'orange' },
  { x: 96, y: 312, r: 6, c: 'blue' },
  { x: 152, y: 366, r: 4, c: 'teal' },
  { x: 246, y: 122, r: 4, c: 'blue' },
];
const LEFT_EDGES = [
  [0, 1], [0, 2], [1, 2], [2, 3], [2, 4], [3, 5], [4, 6], [5, 6], [1, 7], [2, 7],
];

const mirror = (n) => ({ ...n, x: 1280 - n.x });
const RIGHT = LEFT.map(mirror);

const node = (t) => (n) =>
  `    <circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${t[n.c]}" stroke="${t.nodeStroke}" stroke-width="2"/>`;

const edge = (t, nodes) => ([a, b]) =>
  `    <line x1="${nodes[a].x}" y1="${nodes[a].y}" x2="${nodes[b].x}" y2="${nodes[b].y}" stroke="${t.edge}" stroke-width="1.5"/>`;

const cluster = (t, nodes, edges) =>
  [...edges.map(edge(t, nodes)), ...nodes.map(node(t))].join('\n');

const COPY = {
  en: {
    suffix: '',
    desc: 'Deterministic, layered code knowledge graph for any JS/TS repo, with an MCP server for agents.',
    tagline: 'Deterministic, layered code knowledge graph for any JS/TS repo',
  },
  ru: {
    suffix: '-ru',
    desc: 'Детерминированный слоистый граф знаний о коде для любого JS/TS-репозитория, с MCP-сервером для агентов.',
    tagline: 'Детерминированный слоистый граф знаний о коде для JS/TS',
  },
};

function banner(t, c) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 400" width="1280" height="400" role="img" aria-labelledby="title desc">
  <title id="title">loregraph</title>
  <desc id="desc">${c.desc}</desc>

  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${t.bg1}"/>
      <stop offset="100%" stop-color="${t.bg2}"/>
    </linearGradient>
    <radialGradient id="halo" cx="50%" cy="46%" r="52%">
      <stop offset="0%" stop-color="${t.glow}" stop-opacity="${t.glowOpacity}"/>
      <stop offset="100%" stop-color="${t.glow}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${t.blue}" stop-opacity="0"/>
      <stop offset="18%" stop-color="${t.blue}"/>
      <stop offset="50%" stop-color="${t.purple}"/>
      <stop offset="82%" stop-color="${t.teal}"/>
      <stop offset="100%" stop-color="${t.teal}" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <rect width="1280" height="400" fill="url(#bg)"/>
  <rect width="1280" height="400" fill="url(#halo)"/>

  <g opacity="0.85">
${cluster(t, LEFT, LEFT_EDGES)}
  </g>
  <g opacity="0.85">
${cluster(t, RIGHT, LEFT_EDGES)}
  </g>

  <!-- mark: three files resolving into one graph node -->
  <g transform="translate(640 96)">
    <line x1="-46" y1="14" x2="0" y2="-22" stroke="${t.edge}" stroke-width="2.5"/>
    <line x1="46" y1="14" x2="0" y2="-22" stroke="${t.edge}" stroke-width="2.5"/>
    <line x1="-46" y1="14" x2="46" y2="14" stroke="${t.edge}" stroke-width="2.5" stroke-dasharray="4 5"/>
    <circle cx="0" cy="-22" r="13" fill="${t.blue}"/>
    <circle cx="-46" cy="14" r="10" fill="${t.purple}"/>
    <circle cx="46" cy="14" r="10" fill="${t.teal}"/>
  </g>

  <g font-family="'Inter', 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif" text-anchor="middle">
    <text x="640" y="226" font-size="104" font-weight="700" letter-spacing="-3" fill="${t.text}">loregraph</text>
    <text x="640" y="278" font-size="25" font-weight="500" fill="${t.muted}">${c.tagline}</text>
    <text x="640" y="342" font-size="17" font-weight="600" letter-spacing="3.2" fill="${t.chip}">INVENTORY · IMPORTS · SYMBOLS · REFERENCES · USAGES · DOMAINS · MCP</text>
  </g>

  <rect x="480" y="300" width="320" height="3" rx="1.5" fill="url(#rule)"/>
</svg>
`;
}

for (const [name, t] of Object.entries(THEMES)) {
  for (const c of Object.values(COPY)) {
    writeFileSync(
      join(OUT_DIR, `banner-${name}${c.suffix}.svg`),
      banner(t, c),
    );
  }
}
console.log(`wrote 4 banners to ${OUT_DIR}`);
