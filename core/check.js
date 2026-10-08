'use strict';
/**
 * Offline drift checks between the token source, the generated tokens, the
 * component map and the Figma snapshot. Never reads Figma (snapshot.js does).
 * Ported from check_design_sync.py (Math Sheets Unlimited / Seesay Lingo).
 *
 *   (a) generated tokens are fresh against their source; the adapter resolved
 *       every value it was asked to
 *   (b) map integrity — each entry's code file exists and declares its symbol
 *       (unless `code.pending`), no Figma component is claimed twice, `pending`
 *       debts are reported every run
 *   (r) roster (optional, supplied by the caller) — every code component has a
 *       map entry, and every axis the map ties to a code prop agrees with the
 *       values the code actually accepts, both ways
 *   (c) snapshot ↔ map — same names both ways, every Figma variant value is
 *       mapped or `nonApi`, every Figma property has a home, and nothing the
 *       map declares is missing from Figma
 *   (i) icons — the one icon component's axis values equal the map's icon
 *       table, and every code key it names exists
 *
 * UI lint (raw colours, raw fonts) is deliberately NOT here — a repo's own
 * linter owns that, and two linters disagreeing is its own kind of drift.
 */

const fs = require('fs');
const path = require('path');
const tokens = require('./tokens');
const { figmaNames } = require('./snapshot');
const { readJson, escapeRe, rel } = require('./util');

const NON_API = (v) => v && typeof v === 'object' && v.nonApi;
/** The code side of a map entry: `code` (any platform) or the Swift-era `swift`. */
const codeOf = (e) => e.code || e.swift || {};

/** The declaration regex for an entry: per-kind patterns win over the default. */
function declFor(config, kind) {
  const c = config.code || {};
  return (c.declPatterns && (c.declPatterns[kind] || c.declPatterns.default)) || c.declPattern || null;
}

/**
 * @param config   loaded figma-code-sync config
 * @param opts.roster  { [symbol]: { file?, props?: { [prop]: string[] } } } — the
 *                 code side's components, when the caller can evaluate them
 * @param opts.iconKeys  string[] — every icon key the code can render
 */
function run(config, opts = {}) {
  const errors = [];
  const warnings = [];
  const err = (where, msg) => errors.push(`error   ${where} — ${msg}`);
  const warn = (where, msg) => warnings.push(`warning ${where} — ${msg}`);
  const R = (p) => path.resolve(config.root, p);

  // (a)
  if (config.tokens) {
    try {
      const t = tokens.check(config);
      for (const e of t.errors) err(config.tokens.source, e);
      if (!t.fresh) err(rel(config.root, t.out), 'stale — run the tokens step (figma-code-sync tokens)');
    } catch (e) {
      err(config.tokens.source, e.message);
    }
  }

  const mapRel = config.paths.map;
  let cmap;
  try {
    cmap = readJson(R(mapRel));
  } catch (e) {
    err(mapRel, `cannot read: ${e.message}`);
    return { errors, warnings };
  }
  const entries = cmap.components || [];

  // (b)
  const claimed = {};
  for (const e of entries) {
    const where = `${mapRel}:${e.id || '?'}`;
    const code = codeOf(e);
    const decl = declFor(config, code.kind);
    if (code.pending) {
      warn(where, `${code.symbol} awaits its code — ${typeof code.pending === 'string' ? code.pending : 'no reason recorded'}`);
    } else if (!code.file || !fs.existsSync(R(code.file))) {
      err(where, `code.file does not exist: ${code.file} (mark code.pending if it is not built yet)`);
    } else if (decl && code.symbol) {
      const binding = code.export || code.symbol;
      const re = new RegExp(decl.split('{sym}').join(escapeRe(binding)), 'm');
      if (!re.test(fs.readFileSync(R(code.file), 'utf8'))) err(where, `${binding} is not exported from ${code.file}`);
    }
    for (const n of figmaNames(e)) {
      if (claimed[n]) err(where, `Figma component ${JSON.stringify(n)} is also claimed by ${claimed[n]}`);
      claimed[n] = e.id;
    }
    if (e.figma == null && e.pending) {
      warn(where, `awaits a Figma component — ${typeof e.pending === 'string' ? e.pending : 'no reason recorded'}`);
    } else if (e.figma == null) {
      err(where, 'figma is null with no `pending` note — say what Figma owes, or point it at a component');
    }
  }

  // (r)
  if (opts.roster) {
    const bySymbol = new Map(entries.map((e) => [codeOf(e).symbol, e]));
    for (const [symbol, info] of Object.entries(opts.roster)) {
      const e = bySymbol.get(symbol);
      if (!e) {
        err(mapRel, `${symbol} is a code component with no map entry`);
        continue;
      }
      const where = `${mapRel}:${e.id}`;
      if (info.file && codeOf(e).file && path.basename(codeOf(e).file) !== path.basename(info.file)) {
        err(where, `code.file is ${codeOf(e).file} but the component lives in ${info.file}`);
      }
      for (const [axis, spec] of Object.entries(e.axes || {})) {
        if (!spec.prop) continue;
        const accepted = (info.props || {})[spec.prop];
        if (!accepted) {
          err(where, `axis ${axis} maps prop ${spec.prop}, which ${symbol} does not enumerate`);
          continue;
        }
        const mapped = new Set(Object.values(spec.values || {}).filter((v) => !NON_API(v)));
        for (const v of accepted) if (!mapped.has(v)) err(where, `${spec.prop}="${v}" exists in code but no ${axis} value maps to it`);
        for (const v of mapped) if (!accepted.includes(v)) err(where, `${axis} maps to ${spec.prop}="${v}", which ${symbol} does not accept`);
      }
    }
    for (const e of entries) {
      const sym = codeOf(e).symbol;
      // a design-first entry (code.pending) is not in the roster yet by definition
      if (sym && !(sym in opts.roster) && !e.composite && !codeOf(e).pending) {
        err(`${mapRel}:${e.id}`, `${sym} is not in the code roster (mark the entry "composite": true if it is built from roster parts)`);
      }
    }
  }

  // (c)
  const snapRel = config.paths.snapshot;
  let snap = null;
  try {
    snap = readJson(R(snapRel), null); // null only when the file is missing
  } catch (e) {
    err(snapRel, e.message); // a snapshot that exists but will not parse must never read as "no snapshot"
    return { errors, warnings };
  }
  const icons = cmap.icons || null;
  // Two icon shapes: one component per icon under a prefix (`Icon/plus`), or one
  // set with a name axis (`Icon`, Name=plus). The snapshot side is normalised
  // to a list of icon names either way.
  const iconPrefix = icons && icons.figma && icons.figma.prefix;
  const iconComponent = icons && icons.figma && icons.figma.component;
  const isIcon = (name) => (iconPrefix ? name.startsWith(iconPrefix) : name === iconComponent);
  if (!snap) {
    warn(snapRel, 'no snapshot yet — refresh it from the published Library');
  } else {
    const byFigma = {};
    for (const e of entries) for (const n of figmaNames(e)) byFigma[n] = e;
    const snapByName = new Map((snap.components || []).map((c) => [c.name, c]));
    // Name identity is exact, but a near miss deserves a hint: `button` vs
    // `Button`, or `Primary Button` vs `PrimaryButton`, is the usual half-synced state.
    const fold = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, '');
    const nearest = (name, pool) => pool.find((p) => p !== name && fold(p) === fold(name));
    const mapNames = entries.flatMap((e) => [...figmaNames(e), codeOf(e).symbol]).filter(Boolean);
    for (const comp of snap.components || []) {
      const where = `${snapRel}:${comp.name}`;
      if (icons && isIcon(comp.name)) continue;
      const e = byFigma[comp.name];
      if (!e) {
        const near = nearest(comp.name, mapNames);
        err(where, `Figma component has no entry in ${mapRel}${near ? ` — did you mean ${JSON.stringify(near)}? Names must match exactly` : ''}`);
        continue;
      }
      for (const [axis, values] of Object.entries(comp.axes || {})) {
        const spec = (e.axes || {})[axis];
        if (!spec) {
          err(where, `axis ${JSON.stringify(axis)} is not in the map entry ${e.id}`);
          continue;
        }
        const mapped = new Set(Object.keys(spec.values || {}));
        for (const v of values) if (!mapped.has(v)) err(where, `${axis}=${v} is not mapped (add a value or mark it nonApi)`);
      }
      const homes = new Set([...Object.keys(e.properties || {}), ...Object.keys(e.slots || {})]);
      for (const [prop, type] of Object.entries(comp.properties || {})) {
        if (!homes.has(prop)) err(where, `${type} property ${JSON.stringify(prop)} has no home in the map (properties/slots)`);
      }
    }
    for (const e of entries) {
      for (const n of figmaNames(e)) {
        const comp = snapByName.get(n);
        const where = `${mapRel}:${e.id}`;
        if (!comp) {
          const near = nearest(n, [...snapByName.keys()]);
          err(where, `maps Figma component ${JSON.stringify(n)} which is not in the snapshot${near ? ` — the Library has ${JSON.stringify(near)}; names must match exactly` : ''}`);
          continue;
        }
        const declared = Object.entries({ ...(e.properties || {}), ...(e.slots || {}) }).filter(([, v]) => !(v && v.figma === false));
        for (const [prop] of declared) {
          if (!(prop in (comp.properties || {}))) err(where, `declares ${JSON.stringify(prop)} but ${n} has no such property in the snapshot`);
        }
        for (const [axis, spec] of Object.entries(e.axes || {})) {
          const figmaValues = (comp.axes || {})[axis];
          if (!figmaValues) {
            err(where, `declares axis ${JSON.stringify(axis)} but ${n} has no such axis in the snapshot`);
            continue;
          }
          // the reverse of "not mapped": a value the map promises that Figma never published
          for (const v of Object.keys(spec.values || {})) {
            if (!figmaValues.includes(v)) err(where, `maps ${axis}=${v} but ${n} has no such value in the snapshot`);
          }
        }
      }
    }
    // (i)
    if (icons && (iconPrefix || iconComponent)) {
      const table = new Set(Object.keys(icons.values || {}));
      let inFigma;
      if (iconPrefix) {
        inFigma = new Set((snap.components || []).filter((c) => isIcon(c.name)).map((c) => c.name.slice(iconPrefix.length)));
      } else {
        const comp = snapByName.get(iconComponent);
        inFigma = comp ? new Set(((comp.axes || {})[icons.figma.axis || 'Name']) || []) : null;
      }
      const label = (n) => (iconPrefix ? iconPrefix + n : `${iconComponent} ${icons.figma.axis || 'Name'}=${n}`);
      if (!inFigma || !inFigma.size) {
        if (table.size) warn(`${mapRel}:icons`, 'no icon components in the snapshot yet');
      } else {
        for (const n of inFigma) if (!table.has(n)) err(`${snapRel}:${label(n)}`, 'has no entry in the icons table of the map');
        for (const n of table) if (!inFigma.has(n)) err(`${mapRel}:icons.${n}`, `no ${label(n)} in the snapshot`);
      }
    }
  }
  if (icons && opts.iconKeys) {
    const keys = new Set(opts.iconKeys);
    for (const [figmaName, codeKey] of Object.entries(icons.values || {})) {
      if (!keys.has(codeKey)) err(`${mapRel}:icons.${figmaName}`, `code icon ${JSON.stringify(codeKey)} does not exist`);
    }
  }

  return { errors, warnings };
}

/** The same findings as structured data, for `--json` and for agents. */
function toJson({ errors, warnings }) {
  const parse = (line) => {
    const m = /^(error|warning)\s+(.+?) — ([\s\S]+)$/.exec(line);
    return m ? { level: m[1], where: m[2], message: m[3] } : { level: 'error', where: '', message: line };
  };
  return { ok: errors.length === 0, errors: errors.map(parse), warnings: warnings.map(parse) };
}

function print({ errors, warnings }) {
  for (const line of [...warnings, ...errors]) console.log(line);
  console.log(`figma-code-sync check: ${errors.length} error(s), ${warnings.length} warning(s)`);
  return errors.length ? 1 : 0;
}

module.exports = { run, print, toJson, codeOf };
