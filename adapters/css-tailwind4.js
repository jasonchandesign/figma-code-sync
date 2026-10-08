'use strict';
/**
 * Token adapter: a Tailwind v4 / shadcn theme stylesheet is the source of truth.
 *
 * Reads the custom-property blocks of one CSS file and resolves them per mode,
 * in source order, so a later block (a brand override, a light-only surface
 * step) wins exactly as it does in the browser. What becomes a token is decided
 * by the stylesheet's own `@theme` map, not by a list kept here:
 *
 *   --color-<role>: var(--<role>)            → color.<role>   (one value per mode)
 *   --radius-<step>: calc(var(--radius) * k) → radius.<step>  (px)
 *   --font-<name>: '<Family>', …             → font.<name>
 *
 * A role that `@theme` maps but no block defines is an error, because the
 * utility it backs would paint nothing.
 *
 * Options (config.tokens.options):
 *   modes      { <mode>: [selector, …] } — which blocks feed which mode
 *   remPx      px per rem for dimensions (default 16)
 *   figmaFonts { <css family>: <Figma family> } — e.g. a self-hosted
 *              'Inter Variable' is the family Figma calls 'Inter'
 *   spacing    { steps: [0.5, 1, 1.5, 2, …] } — publish Tailwind's spacing scale.
 *              Needs `--spacing` declared in an @theme block (Tailwind v4's
 *              own base; declaring its default 0.25rem changes nothing on
 *              screen). Each step N becomes spacing.<N> = base × N px, with
 *              web code syntax `calc(var(--spacing) * N)` — exactly what the
 *              utility p-N compiles to. Half steps are named 0-5, 1-5, …
 *              because neither DTCG nor Figma allows '.' in a token name.
 */

const fs = require('fs');
const { cssColorToHex } = require('../core/color');

const DEFAULT_MODES = {
  light: [':root', ':root, .dark', ':root:not(.dark)'],
  dark: ['.dark', ':root, .dark'],
};

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const normSelector = (s) => s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();

/** Innermost `selector { decls }` blocks, in source order. */
function blocks(css) {
  const out = [];
  const re = /([^{};]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const prop = d.slice(0, i).trim();
      if (prop.startsWith('--')) decls[prop] = d.slice(i + 1).trim();
    }
    out.push({ selector: normSelector(m[1]), decls });
  }
  return out;
}

function toPx(value, vars, remPx) {
  const v = value.trim();
  let m = /^var\((--[\w-]+)\)$/.exec(v);
  if (m) return vars[m[1]] != null ? toPx(vars[m[1]], vars, remPx) : null;
  m = /^calc\(\s*var\((--[\w-]+)\)\s*\*\s*([\d.]+)\s*\)$/.exec(v);
  if (m) {
    const base = vars[m[1]] != null ? toPx(vars[m[1]], vars, remPx) : null;
    return base == null ? null : base * parseFloat(m[2]);
  }
  m = /^([\d.]+)(rem|px)$/.exec(v);
  if (m) return parseFloat(m[1]) * (m[2] === 'rem' ? remPx : 1);
  return null;
}

const round = (n) => Math.round(n * 100) / 100;

function read({ source, options = {} }) {
  const css = stripComments(fs.readFileSync(source, 'utf8'));
  const modes = options.modes || DEFAULT_MODES;
  const remPx = options.remPx || 16;
  const all = blocks(css);

  const theme = {};
  for (const b of all) if (b.selector.startsWith('@theme')) Object.assign(theme, b.decls);

  const byMode = {};
  for (const mode of Object.keys(modes)) {
    const wanted = modes[mode].map(normSelector);
    byMode[mode] = {};
    for (const b of all) if (wanted.includes(b.selector)) Object.assign(byMode[mode], b.decls);
  }
  const modeNames = Object.keys(modes);
  const first = modeNames[0];

  const tree = { color: {}, radius: {}, spacing: {}, font: {} };
  const errors = [];

  for (const [prop, value] of Object.entries(theme)) {
    let m = /^--color-([\w-]+)$/.exec(prop);
    const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
    if (m && !ref) {
      // a literal in @theme (`--color-brand: #ff0000`) is one value for every mode
      const hex = cssColorToHex(value);
      if (!hex) { errors.push(`${prop} is neither a var() reference nor a colour this can resolve: ${value}`); continue; }
      const modesExt = {};
      for (const mode of modeNames.slice(1)) modesExt[mode] = hex;
      tree.color[m[1]] = {
        $type: 'color',
        $value: hex,
        $extensions: { modes: modesExt, source: Object.fromEntries(modeNames.map((mo) => [mo, value])), web: { var: `var(${prop})` }, figma: { name: `color/${m[1]}` } },
      };
      continue;
    }
    if (m && ref) {
      const role = m[1];
      const perMode = {};
      const raw = {};
      for (const mode of modeNames) {
        // follow `--a: var(--b)` aliases within the mode, as the browser would
        let v = byMode[mode][ref[1]];
        for (let hops = 0; v != null && hops < 10; hops++) {
          const alias = /^var\((--[\w-]+)\)$/.exec(v.trim());
          if (!alias) break;
          v = byMode[mode][alias[1]];
        }
        if (v == null) {
          errors.push(`${prop} maps ${ref[1]}, which no ${mode} block defines`);
          continue;
        }
        const hex = cssColorToHex(v);
        if (!hex) {
          errors.push(`${ref[1]} (${mode}) is not a colour this can resolve: ${v}`);
          continue;
        }
        perMode[mode] = hex;
        raw[mode] = v;
      }
      if (!perMode[first]) continue;
      const modesExt = {};
      for (const mode of modeNames.slice(1)) modesExt[mode] = perMode[mode];
      tree.color[role] = {
        $type: 'color',
        $value: perMode[first],
        $extensions: {
          modes: modesExt,
          source: raw,
          web: { var: `var(${ref[1]})` },
          figma: { name: `color/${role}` },
        },
      };
      continue;
    }
    m = /^--radius-([\w-]+)$/.exec(prop);
    if (m) {
      const px = toPx(value, { ...theme, ...byMode[first] }, remPx);
      if (px == null) {
        errors.push(`${prop} is not a dimension this can resolve: ${value}`);
        continue;
      }
      tree.radius[m[1]] = {
        $type: 'dimension',
        $value: `${round(px)}px`,
        $extensions: { web: { var: `var(${prop})` }, figma: { name: `radius/${m[1]}` } },
      };
      continue;
    }
    m = /^--font-([\w-]+)$/.exec(prop);
    if (m) {
      const resolved = /^var\(/.test(value.trim()) ? theme[value.trim().slice(4, -1)] || value : value;
      const family = resolved.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
      tree.font[m[1]] = {
        $type: 'fontFamily',
        $value: family,
        $extensions: {
          web: { var: `var(${prop})` },
          figma: { name: `font/${m[1]}`, family: (options.figmaFonts || {})[family] || family },
        },
      };
    }
  }

  if (options.spacing && options.spacing.steps) {
    const base = theme['--spacing'];
    const px = base != null ? toPx(base, { ...theme, ...byMode[first] }, remPx) : null;
    if (px == null) errors.push('options.spacing is set but no @theme block declares --spacing (e.g. `@theme { --spacing: 0.25rem; }`)');
    else {
      for (const step of options.spacing.steps) {
        const name = String(step).replace('.', '-');
        tree.spacing[name] = {
          $type: 'dimension',
          $value: `${round(px * step)}px`,
          $extensions: { web: { var: `calc(var(--spacing) * ${step})`, utility: `p-${step}` }, figma: { name: `spacing/${name}` } },
        };
      }
    }
  }
  if (!Object.keys(tree.spacing).length) delete tree.spacing;

  // Deterministic order, whatever order the stylesheet declares them in.
  // Spacing keeps its numeric scale order; everything else is alphabetical.
  for (const group of Object.keys(tree)) {
    if (group === 'spacing') continue;
    tree[group] = Object.fromEntries(Object.entries(tree[group]).sort(([a], [b]) => a.localeCompare(b)));
  }
  return { tree, modes: modeNames, errors };
}

module.exports = { read, blocks, toPx };
