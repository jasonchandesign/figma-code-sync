'use strict';
/**
 * Token adapter (emit mode): design/tokens.json is the truth, SwiftUI is generated.
 * A line-for-line port of the gen_theme.py that Math Sheets Unlimited and Seesay
 * Lingo run, so an existing repo can switch with no diff in its generated file.
 *
 *   palette.<group>.<x>  → extension Theme     { static let navy900 = Color(hex: 0x1E2552) }
 *   color.<group>.<x>    → extension Theme     { static let textPrimary = navy900 }   (aliases keep the name)
 *   spacing.* / radius.* → extension Layout/Radius/Theme  per $extensions.swift.name
 *   type.*               → extension AppFont   { static let displayXL = TextStyle(...) }
 *   effect.*             → extension Elevation { static let glassSheet = ShadowStyle(...) }
 *
 * $description is emitted as `///` (it is shared with Figma); $extensions.swift.doc
 * is appended for code-only notes. Colours may carry alpha (#RRGGBBAA).
 *
 * Options (config.tokens.options):
 *   header     the generator named in the first line (default "figma-code-sync tokens")
 *   source     the token file named in the header (default "design/tokens.json")
 *   regenerate the command named in the second line
 */

class TokenError extends Error {}

const METRIC_GROUPS = ['spacing', 'radius'];
const METRIC_CONTAINERS = ['Layout', 'Radius', 'Theme'];
const NUMERIC_TYPES = new Set(['sizing', 'spacing', 'borderRadius', 'borderWidth', 'dimension']);
const WEIGHTS = { regular: '.regular', medium: '.medium', semibold: '.semibold', bold: '.bold' };
const DOC_WIDTH = 72;

// ── helpers ───────────────────────────────────────────────────────────────

function camel(...segments) {
  const words = [];
  for (const seg of segments) words.push(...String(seg).split(/[-_ ]+/).filter(Boolean));
  if (!words.length) throw new TokenError('empty name');
  const [head, ...tail] = words;
  return head[0].toLowerCase() + head.slice(1) + tail.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

function typeName(key) {
  const parts = key.split('-');
  return parts[0] + parts.slice(1).map((p) => (['xs', 's', 'm', 'l', 'xl', 'xxl'].includes(p) ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join('');
}

const isToken = (n) => n && typeof n === 'object' && !Array.isArray(n) && '$value' in n;

// JS objects enumerate integer-like keys ("700", "900") first, in numeric order;
// Python keeps file order, and the generated Swift follows file order. So the
// token file is parsed with its key order recorded, and walked in that order.
const ORDER = Symbol('keyOrder');
function parse(text) {
  let i = 0;
  const ws = () => { while (/\s/.test(text[i])) i++; };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj = {};
      const order = [];
      ws();
      if (text[i] === '}') { i++; Object.defineProperty(obj, ORDER, { value: order }); return obj; }
      for (;;) {
        ws();
        const k = value();
        ws(); i++; // :
        obj[k] = value();
        order.push(k);
        ws();
        if (text[i++] === '}') break; // else ','
      }
      Object.defineProperty(obj, ORDER, { value: order });
      return obj;
    }
    if (c === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i++] === ']') break;
      }
      return arr;
    }
    if (c === '"') {
      const start = i;
      i++;
      while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      i++;
      return JSON.parse(text.slice(start, i));
    }
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (!m) throw new TokenError(`invalid JSON at offset ${i}`);
    i += m[0].length;
    return JSON.parse(m[0]);
  };
  const out = value();
  ws();
  if (i < text.length) throw new TokenError(`trailing data at offset ${i}`);
  return out;
}

const keysOf = (n) => n[ORDER] || Object.keys(n);
const children = (n) => keysOf(n).filter((k) => !k.startsWith('$')).map((k) => [k, n[k]]);

function* walk(node, path = []) {
  for (const [k, v] of children(node)) {
    if (isToken(v)) yield [[...path, k], v];
    else if (v && typeof v === 'object') yield* walk(v, [...path, k]);
  }
}

function lookup(tokens, dotted) {
  let cur = tokens;
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object' || !(seg in cur)) throw new TokenError(`dangling alias {${dotted}}`);
    cur = cur[seg];
  }
  if (!isToken(cur)) throw new TokenError(`alias {${dotted}} does not name a token`);
  return cur;
}

const ALIAS = /^\{([^}]+)\}$/;

function resolve(tokens, value, seen = []) {
  const m = ALIAS.exec(String(value));
  if (!m) return value;
  if (seen.includes(m[1])) throw new TokenError(`alias cycle through {${m[1]}}`);
  return resolve(tokens, lookup(tokens, m[1]).$value, [...seen, m[1]]);
}

const swiftExt = (t) => (t.$extensions || {}).swift || {};

/** Python's str(int) for integral floats, repr(float) otherwise. */
function number(value, where) {
  const f = Number(String(value).trim());
  if (String(value).trim() === '' || Number.isNaN(f)) throw new TokenError(`${where}: not a number: ${JSON.stringify(value)}`);
  return String(f);
}

function colorLiteral(value, where) {
  const s = String(value).trim().toUpperCase();
  const m = /^#([0-9A-F]{6})([0-9A-F]{2})?$/.exec(s);
  if (!m) throw new TokenError(`${where}: not a #RRGGBB[AA] colour: ${JSON.stringify(value)}`);
  if (m[2] && m[2] !== 'FF') {
    const opacity = Math.round((parseInt(m[2], 16) / 255) * 100) / 100;
    return `Color(hex: 0x${m[1]}, opacity: ${number(opacity, where)})`;
  }
  return `Color(hex: 0x${m[1]})`;
}

/** textwrap.wrap(width, break_long_words=False, break_on_hyphens=False). */
function wrap(text, width) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const paragraphs = (text) => text.split('\n\n').map((p) => p.trim()).filter(Boolean);

function docLines(token, indent) {
  const parts = [];
  if (token.$description) parts.push(token.$description);
  if (swiftExt(token).doc) parts.push(swiftExt(token).doc);
  const out = [];
  parts.forEach((part, i) => {
    if (i) out.push(indent + '///');
    paragraphs(part).forEach((para, j) => {
      if (j) out.push(indent + '///');
      for (const l of wrap(para, DOC_WIDTH - indent.length - 4)) out.push(indent + '/// ' + l);
    });
  });
  return out;
}

function blockComment(text, indent = '') {
  const out = [];
  paragraphs(text).forEach((para, j) => {
    if (j) out.push(indent + '//');
    for (const l of wrap(para, DOC_WIDTH - indent.length - 3)) out.push(indent + '// ' + l);
  });
  return out;
}

// ── Swift names ───────────────────────────────────────────────────────────

function swiftName(tokens, path) {
  const token = lookup(tokens, path.join('.'));
  const ext = swiftExt(token);
  if ('skip' in ext) return null;
  if ('name' in ext) {
    if (!ext.name.includes('.')) throw new TokenError(`${path.join('.')}: swift.name must be qualified (Layout.x / Radius.x)`);
    return ext.name;
  }
  const group = path[0];
  if (group === 'palette' || group === 'color') return 'Theme.' + camel(...path.slice(1));
  if (group === 'type') return 'AppFont.' + typeName(path[1]);
  if (group === 'effect') return 'Elevation.' + camel(path[1]);
  if (METRIC_GROUPS.includes(group)) throw new TokenError(`${path.join('.')}: metric needs $extensions.swift.name or swift.skip`);
  return null;
}

function aliasTargetName(tokens, value) {
  const m = ALIAS.exec(String(value));
  if (!m) return null;
  try {
    return swiftName(tokens, m[1].split('.'));
  } catch {
    return null;
  }
}

const unqualified = (name, container) => (name.startsWith(container + '.') ? name.slice(container.length + 1) : name);

function register(used, name) {
  if (used.has(name)) throw new TokenError(`duplicate Swift identifier ${name}`);
  used.add(name);
}

// ── sections ──────────────────────────────────────────────────────────────

/** A top-level group that the Swift shape requires, or a TokenError naming it. */
function groupOf(tokens, name) {
  const g = tokens[name];
  if (!g || typeof g !== 'object') throw new TokenError(`tokens.json has no \`${name}\` group (the swift adapter needs palette, color, font-family and type)`);
  return g;
}

function renderPalette(tokens, used) {
  const group = groupOf(tokens, 'palette');
  const lines = ['// MARK: - Palette'];
  if (group.$description) lines.push(...blockComment(group.$description));
  lines.push('extension Theme {');
  for (const [path, tok] of walk(group, ['palette'])) {
    const name = swiftName(tokens, path);
    if (name == null) continue; // swift.skip
    register(used, name);
    lines.push(...docLines(tok, '    '));
    lines.push(`    static let ${unqualified(name, 'Theme')} = ${colorLiteral(resolve(tokens, tok.$value), path.join('.'))}`);
  }
  lines.push('}');
  return lines;
}

function renderSemantic(tokens, used) {
  const group = groupOf(tokens, 'color');
  const lines = ['// MARK: - Semantic colour'];
  if (group.$description) lines.push(...blockComment(group.$description));
  lines.push('extension Theme {');
  for (const [path, tok] of walk(group, ['color'])) {
    if (path.length !== 3) throw new TokenError(`${path.join('.')}: semantic colours are exactly color.<group>.<name>`);
    const name = swiftName(tokens, path);
    if (name == null) continue; // swift.skip
    register(used, name);
    const target = aliasTargetName(tokens, tok.$value);
    const rhs = target ? unqualified(target, 'Theme') : colorLiteral(resolve(tokens, tok.$value), path.join('.'));
    lines.push(...docLines(tok, '    '));
    lines.push(`    static let ${unqualified(name, 'Theme')} = ${rhs}`);
  }
  lines.push('}');
  return lines;
}

function renderMetrics(tokens, used) {
  const per = Object.fromEntries(METRIC_CONTAINERS.map((c) => [c, []]));
  for (const group of METRIC_GROUPS) {
    const node = tokens[group];
    if (!node) continue;
    const marked = new Set();
    for (const [path, tok] of walk(node, [group])) {
      const name = swiftName(tokens, path);
      if (name == null) continue;
      const container = name.split('.')[0];
      if (!(container in per)) throw new TokenError(`${path.join('.')}: swift.name container must be one of ${METRIC_CONTAINERS.join(', ')}`);
      if (!NUMERIC_TYPES.has(tok.$type)) throw new TokenError(`${path.join('.')}: metric with unsupported $type ${JSON.stringify(tok.$type)}`);
      register(used, name);
      const out = per[container];
      if (!marked.has(container)) {
        out.push(`    // MARK: ${group}`);
        if (node.$description) out.push(...blockComment(node.$description, '    '));
        marked.add(container);
      }
      out.push(...docLines(tok, '    '));
      out.push(`    static let ${unqualified(name, container)}: CGFloat = ${number(resolve(tokens, tok.$value), path.join('.'))}`);
    }
  }
  const lines = ['// MARK: - Metrics'];
  for (const c of METRIC_CONTAINERS) {
    if (per[c].length) lines.push(`extension ${c} {`, ...per[c], '}');
  }
  return lines;
}

function renderType(tokens, used) {
  const group = groupOf(tokens, 'type');
  const families = Object.fromEntries(children(groupOf(tokens, 'font-family')).map(([k, t]) => [resolve(tokens, t.$value), k]));
  const lines = ['// MARK: - Type'];
  if (group.$description) lines.push(...blockComment(group.$description));
  lines.push('extension AppFont {');
  for (const [key, tok] of children(group)) {
    const path = ['type', key];
    const where = path.join('.');
    if (tok.$type !== 'typography') throw new TokenError(`${where}: expected $type typography`);
    const name = swiftName(tokens, path);
    if (name == null) continue; // swift.skip
    register(used, name);
    const v = tok.$value;
    const family = resolve(tokens, v.fontFamily || '');
    if (!(family in families)) throw new TokenError(`${where}: unknown font family ${JSON.stringify(family)}`);
    const weight = WEIGHTS[String(resolve(tokens, v.fontWeight || 'regular')).toLowerCase().replace(/ /g, '')];
    if (!weight) throw new TokenError(`${where}: unknown font weight ${JSON.stringify(v.fontWeight)}`);
    const args = [`family: .${families[family]}`, `weight: ${weight}`, `size: ${number(resolve(tokens, v.fontSize), where + '.fontSize')}`];
    if (v.lineHeight != null && v.lineHeight !== '') args.push(`lineHeight: ${number(resolve(tokens, v.lineHeight), where + '.lineHeight')}`);
    lines.push(...docLines(tok, '    '));
    lines.push(`    static let ${unqualified(name, 'AppFont')} = TextStyle(${args.join(', ')})`);
  }
  lines.push('}');
  return lines;
}

function renderEffects(tokens, used) {
  const group = tokens.effect;
  if (!group) return [];
  const lines = ['// MARK: - Effects'];
  if (group.$description) lines.push(...blockComment(group.$description));
  lines.push('extension Elevation {');
  for (const [key, tok] of children(group)) {
    const path = ['effect', key];
    const w = path.join('.');
    if (tok.$type !== 'shadow') throw new TokenError(`${w}: expected $type shadow`);
    const name = swiftName(tokens, path);
    if (name == null) continue; // swift.skip
    register(used, name);
    const v = tok.$value;
    const args = [`color: ${colorLiteral(resolve(tokens, v.color), w + '.color')}`, `x: ${number(v.x ?? 0, w + '.x')}`, `y: ${number(v.y ?? 0, w + '.y')}`, `blur: ${number(v.blur ?? 0, w + '.blur')}`];
    if (v.backgroundBlur != null && v.backgroundBlur !== '') args.push(`backgroundBlur: ${number(v.backgroundBlur, w + '.backgroundBlur')}`);
    lines.push(...docLines(tok, '    '));
    lines.push(`    static let ${unqualified(name, 'Elevation')} = ShadowStyle(${args.join(', ')})`);
  }
  lines.push('}');
  return lines;
}

// ── render ────────────────────────────────────────────────────────────────

function render(input, { sha256 = '', options = {} } = {}) {
  const tokens = typeof input === 'string' ? parse(input) : input;
  const used = new Set();
  const sections = [renderPalette, renderSemantic, renderMetrics, renderType, renderEffects].map((f) => f(tokens, used));
  const source = options.source || 'design/tokens.json';
  const header = options.header || 'figma-code-sync tokens';
  const regenerate = options.regenerate || 'npx figma-code-sync tokens';
  const head = [
    `// Generated by ${header} from ${source} (sha256: ${sha256.slice(0, 12)}) — do not edit.`,
    `// Change ${source} and run \`${regenerate}\`. Prose comes from each`,
    "// token's $description and $extensions.swift.doc.",
    '',
    'import SwiftUI',
    '',
  ];
  const body = [];
  for (const s of sections) if (s.length) body.push(...s, '');
  return [...head, ...body].join('\n').replace(/\n+$/, '') + '\n';
}

module.exports = { parse, render, swiftName, camel, typeName, wrap, TokenError };
