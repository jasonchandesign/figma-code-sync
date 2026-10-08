'use strict';
/**
 * Refresh the component snapshot from the published Library over REST, or gate
 * on how far the published Library has moved from it.
 *
 *   snapshot                    rewrite the snapshot
 *   snapshot --check            report divergence, exit 0
 *   snapshot --check --block    exit 1 when a divergence changes something the code calls
 *   --message-file PATH         read the waiver from a commit message being written
 *   --soft                      no token, no network or no file key → warn and exit 0
 *
 * Ported from Math Sheets Unlimited / Seesay Lingo (fetch_figma_snapshot.py).
 *
 * What REST can see: `/component_sets` and `/components` return the PUBLISHED
 * library — an unpublished draft is invisible here exactly as it is to a
 * consumer, so work in progress cannot raise a false alarm. `/files/:key`
 * gives per-component property definitions (variant axes in canvas order,
 * TEXT/BOOLEAN/INSTANCE_SWAP props) and every node's geometry and bindings,
 * which is what `shape` is fingerprinted from. Variable VALUES are not on the
 * REST API below Enterprise — that is what the `/design-audit` skill is for.
 *
 * Whether a divergence blocks is decided by the code, not by the person
 * committing: `codeUsage()` counts call sites of each component's code symbol.
 * A breaking change (removed, reshaped, variant or property taken away) to a
 * component the code calls blocks; additive changes and changes to components
 * nothing calls are advisory. A `Design-drift: <Name>, … — reason` line in the
 * commit message waives the named components and leaves the reason in git.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sha256, readJson, writeJson, stringify, figmaToken, walkFiles, escapeRe, rel } = require('./util');

const API = 'https://api.figma.com/v1';

/**
 * The fingerprint format. `shape.hash` is a digest of a serialisation, and two
 * implementations never serialise identically (the Python original writes
 * `16.0` and `", "`; this writes `16` and `","`). A snapshot written by another
 * format is compared on everything EXCEPT the hash — padding, gap, strokes and
 * unbound count still gate — and the next refresh rewrites it in this format.
 * Without this, the first check after migrating would call every component
 * "internals changed" and block on all of them at once.
 */
const HASH_VERSION = 'js2'; // js2: a component set carries one fingerprint PER VARIANT

/** An entry as the gate compares it: without hashes when the formats differ. */
function comparable(entry, legacy) {
  if (!entry || !legacy || !entry.shape) return entry;
  const strip = (s) => { const { hash, ...rest } = s || {}; return rest; }; // eslint-disable-line no-unused-vars
  const shape = strip(entry.shape);
  if (entry.shape.variants) shape.variants = Object.fromEntries(Object.entries(entry.shape.variants).map(([k, v]) => [k, strip(v)]));
  return { ...entry, shape };
}

class SoftFail extends Error {}

async function get(apiPath, token, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(API + apiPath, { headers: { 'X-Figma-Token': token } });
  } catch (e) {
    throw new SoftFail(`cannot reach the Figma API: ${e.message}`);
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    if (res.status === 403) {
      throw new Error(`403 from ${apiPath} — the token cannot read this file, or this endpoint is not on your plan.\n${body}`);
    }
    throw new Error(`HTTP ${res.status} from ${apiPath}\n${body}`);
  }
  return res.json();
}

/** When a set last changed: the latest of its own stamp and its variants'. */
function newest(set, members) {
  const stamps = [set.updated_at, ...members.map((m) => m.updated_at)].filter(Boolean).sort();
  return stamps.length ? stamps[stamps.length - 1] : null;
}

/** A paint as the contract cares about it: which variable, else the hex. */
function paintId(paint) {
  const bound = (paint.boundVariables || {}).color;
  if (bound) return bound.id;
  const c = paint.color || {};
  return '#' + ['r', 'g', 'b'].map((k) => Math.round((c[k] || 0) * 255).toString(16).padStart(2, '0')).join('');
}

const r1 = (n) => Math.round((n || 0) * 10) / 10;

/**
 * A compact description of what a component is made of.
 *   pad, gap   the root's own layout — what a consumer's spacing compensates for
 *   strokes    alignment/weight per stroked layer (a centred stroke sits half outside)
 *   unbound    visible fills and strokes with no variable behind them — a bug, not a token
 *   hash       everything else — sizes, radii, effects, nesting — so a change
 *              none of the above names still trips the gate
 */
function shapeOf(node) {
  // A set is a container: what a consumer binds to is each VARIANT. One
  // fingerprint per variant lets a new variant be additive while a re-padded
  // existing one still trips the gate, and lets the report name which variant.
  if (node.type === 'COMPONENT_SET') {
    const variants = {};
    let unbound = 0;
    for (const child of node.children || []) {
      variants[child.name] = shapeOf(child);
      unbound += variants[child.name].unbound;
    }
    return { variants, unbound, hash: sha256(JSON.stringify(Object.keys(variants).sort().map((k) => [k, variants[k].hash]))).slice(0, 12) };
  }
  const strokes = {};
  const material = [];
  let unbound = 0;
  const walk = (n, p) => {
    const row = [n.type, p, n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft,
      n.itemSpacing, n.layoutMode, n.cornerRadius, n.strokeAlign, n.strokeWeight];
    const box = n.absoluteBoundingBox || {};
    row.push(r1(box.width), r1(box.height));
    for (const paint of n.fills || []) {
      if (paint.type === 'SOLID' && paint.visible !== false) {
        row.push('fill:' + paintId(paint));
        if (!(paint.boundVariables || {}).color) unbound++;
      }
    }
    const live = (n.strokes || []).filter((s) => s.type === 'SOLID' && s.visible !== false);
    for (const paint of live) {
      row.push('stroke:' + paintId(paint));
      if (!(paint.boundVariables || {}).color) unbound++;
    }
    if (live.length && n.strokeAlign) strokes[p || n.name || 'root'] = `${n.strokeAlign}/${n.strokeWeight}`;
    for (const e of n.effects || []) {
      if (e.visible !== false) {
        const o = e.offset || {};
        row.push(`fx:${e.type}:${o.x},${o.y}:${e.radius}`);
      }
    }
    material.push(row);
    for (const child of n.children || []) walk(child, (p ? p + '/' : '') + (child.name || '?'));
  };
  walk(node, '');
  // Python's json.dumps(sort_keys) of a list of lists is just the list; JSON.stringify
  // of the same rows renders None/undefined as null, which keeps hashes comparable.
  const digest = sha256(JSON.stringify(material, (k, v) => (v === undefined ? null : v))).slice(0, 12);
  return {
    pad: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((v) => (v === undefined ? null : v)),
    gap: node.itemSpacing === undefined ? null : node.itemSpacing,
    strokes,
    unbound,
    hash: digest,
  };
}

/** Per-component page, axes, properties and shape, from the file itself. */
function fromDocument(doc) {
  const found = {};
  const walk = (node, page) => {
    if (node.type === 'CANVAS') page = node.name;
    if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
      const isVariant = node.type === 'COMPONENT' && (node.name || '').includes('=');
      if (!isVariant) {
        const defs = node.componentPropertyDefinitions || {};
        const axes = {};
        const props = {};
        for (const [k, v] of Object.entries(defs)) {
          if (v.type === 'VARIANT') axes[k.split('#')[0]] = v.variantOptions;
          else props[k.split('#')[0]] = v.type;
        }
        // Name identity: two components with one name are one contract, and
        // the second silently overwrote the first. Record it so the gate can say so.
        if (found[node.name]) duplicates.add(node.name);
        found[node.name] = {
          page,
          axes: Object.keys(axes).length ? axes : null,
          properties: Object.keys(props).length ? props : null,
          shape: shapeOf(node),
        };
      }
      return;
    }
    for (const child of node.children || []) walk(child, page);
  };
  const duplicates = new Set();
  walk(doc.document || {}, '?');
  found[DUPLICATES] = [...duplicates].sort();
  return found;
}
const DUPLICATES = Symbol('duplicates');

/** Identity from the library listing; everything else from the file. */
async function build(token, current, fetchImpl) {
  const legacy = current.hashVersion !== HASH_VERSION;
  const key = current.fileKey;
  const [sets, comps, doc] = await Promise.all([
    get(`/files/${key}/component_sets`, token, fetchImpl),
    get(`/files/${key}/components`, token, fetchImpl),
    get(`/files/${key}`, token, fetchImpl),
  ]);
  const setMeta = new Map(((sets.meta || {}).component_sets || []).map((s) => [s.node_id, s]));
  const members = new Map();
  const standalone = [];
  for (const c of (comps.meta || {}).components || []) {
    const frame = c.containing_frame || {};
    const holder = frame.containingComponentSet || frame.containingStateGroup || {};
    const sid = holder.nodeId || c.component_set_id;
    if (sid) {
      if (!members.has(sid)) members.set(sid, []);
      members.get(sid).push(c);
    } else standalone.push(c);
  }

  const detail = fromDocument(doc);
  const keep = new Map((current.components || []).map((c) => [c.name, c]));
  const out = [];
  for (const [sid, meta] of setMeta) {
    out.push({ name: meta.name, key: meta.key, nodeId: meta.node_id, type: 'COMPONENT_SET',
      updatedAt: newest(meta, members.get(sid) || []) });
  }
  for (const c of standalone) {
    out.push({ name: c.name, key: c.key, nodeId: c.node_id, type: 'COMPONENT', updatedAt: c.updated_at || null });
  }

  const fresh = [];
  const changed = [];
  const byName = new Map();
  for (const entry of out) {
    const d = detail[entry.name] || {};
    entry.page = d.page || '?';
    for (const field of ['axes', 'properties', 'shape']) if (d[field]) entry[field] = d[field];
    const prev = keep.get(entry.name);
    if (prev) {
      // only the agent can supply these; a refresh must never lose them
      for (const field of ['variables', 'note']) if (field in prev) entry[field] = prev[field];
    }
    byName.set(entry.name, entry);
    if (!prev) fresh.push(entry.name);
    else {
      // A hand-written snapshot entry (the audit skill's no-token fallback) has
      // no shape yet; its first fingerprint is a fill-in, not a change.
      const lg = legacy || !prev.shape;
      const [a, b] = [comparable(prev, lg), comparable(entry, lg)];
      const fields = lg ? ['nodeId', 'page', 'axes', 'properties', 'updatedAt'] : ['nodeId', 'page', 'axes', 'properties', 'shape', 'updatedAt'];
      if (fields.some((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null))) changed.push(entry.name);
    }
  }
  out.sort((a, b) => (a.page + '\0' + a.name).localeCompare(b.page + '\0' + b.name));
  const removed = [...keep.keys()].filter((n) => !byName.has(n)).sort();
  return { components: out, added: fresh, removed, changed: [...new Set(changed)].sort(), byName, duplicates: detail[DUPLICATES] || [] };
}

/** Say what actually moved, so the gate reports rather than only stops. */
function describe(prev, now) {
  if (!prev || !now) return [];
  const said = [];
  if (prev.page !== now.page) said.push(`moved to the ${now.page} page`);
  const pa = prev.axes || {};
  const na = now.axes || {};
  for (const axis of [...new Set([...Object.keys(pa), ...Object.keys(na)])].sort()) {
    const a = new Set(pa[axis] || []);
    const b = new Set(na[axis] || []);
    const plus = [...b].filter((x) => !a.has(x)).sort();
    const minus = [...a].filter((x) => !b.has(x)).sort();
    if (plus.length || minus.length) {
      said.push(`axis ${axis} ${[plus.length ? '+' + plus.join(', ') : '', minus.length ? '-' + minus.join(', ') : ''].filter(Boolean).join(' ')}`);
    }
  }
  const pp = prev.properties || {};
  const np = now.properties || {};
  for (const k of [...new Set([...Object.keys(pp), ...Object.keys(np)])].sort()) {
    if (pp[k] !== np[k]) said.push(`property ${k} ${!(k in pp) ? 'added' : !(k in np) ? 'removed' : 'retyped'}`);
  }
  const j = (x) => JSON.stringify(x ?? null);
  const shapeDiff = (ps, ns, label) => {
    const out = [];
    const at = label ? `${label}: ` : '';
    if (j(ps.pad) !== j(ns.pad)) out.push(`${at}padding ${j(ps.pad)} → ${j(ns.pad)}`);
    if (j(ps.gap) !== j(ns.gap)) out.push(`${at}gap ${j(ps.gap)} → ${j(ns.gap)}`);
    const sa = ps.strokes || {};
    const sb = ns.strokes || {};
    for (const layer of [...new Set([...Object.keys(sa), ...Object.keys(sb)])].sort()) {
      if (sa[layer] !== sb[layer]) out.push(`${at}stroke on ${layer || 'root'} ${sa[layer] ?? 'none'} → ${sb[layer] ?? 'none'}`);
    }
    if (ps.unbound !== ns.unbound) out.push(`${at}unbound values ${ps.unbound} → ${ns.unbound}`);
    if (!out.length && ps.hash !== ns.hash) out.push(`${at}internals changed`);
    return out;
  };
  const ps = prev.shape || {};
  const ns = now.shape || {};
  if (ps.variants || ns.variants) {
    const pv = ps.variants || {};
    const nv = ns.variants || {};
    for (const name of [...new Set([...Object.keys(pv), ...Object.keys(nv)])].sort()) {
      if (!(name in pv)) said.push(`+variant ${name}`);
      else if (!(name in nv)) said.push(`-variant ${name}`);
      else said.push(...shapeDiff(pv[name], nv[name], `variant ${name}`));
    }
  } else said.push(...shapeDiff(ps, ns, ''));
  if (!said.length && prev.updatedAt !== now.updatedAt) said.push('republished, nothing the fingerprint covers moved');
  return said;
}

/** Can this divergence break an existing call site? */
function isAdditive(prev, now, why) {
  if (why === 'added') return true;
  if (why === 'removed') return false;
  const ps = prev.shape || {};
  const ns = now.shape || {};
  if (ps.variants || ns.variants) {
    // every variant that existed must be byte-identical; new variants are additive
    for (const [name, s] of Object.entries(ps.variants || {})) {
      if (JSON.stringify(s) !== JSON.stringify((ns.variants || {})[name])) return false;
    }
  } else if (JSON.stringify(ps) !== JSON.stringify(ns)) return false;
  const pa = prev.axes || {};
  const na = now.axes || {};
  for (const axis of new Set([...Object.keys(pa), ...Object.keys(na)])) {
    const kept = new Set(na[axis] || []);
    if ((pa[axis] || []).some((v) => !kept.has(v))) return false; // a variant went away
  }
  const pp = prev.properties || {};
  const np = now.properties || {};
  for (const k of Object.keys(pp)) if (!(k in np) || pp[k] !== np[k]) return false; // removed or retyped
  return true;
}

/** Figma component names an entry claims. */
function figmaNames(entry) {
  const f = entry.figma;
  if (!f) return [];
  if (Array.isArray(f.components)) return [...f.components];
  return f.component ? [f.component] : [];
}

/**
 * Point a pending map entry at the Figma component that has just appeared.
 * Name identity IS the pairing, so an exact match on the code symbol is not a
 * judgement call. Only `figma` is written; everything else stays hand-authored.
 */
function payOffPending(mapPath, names) {
  const cmap = readJson(mapPath, null);
  if (!cmap) return [];
  const flipped = [];
  for (const entry of cmap.components || []) {
    if (entry.figma != null) continue;
    const symbol = (entry.code || entry.swift || {}).symbol;
    if (symbol && names.has(symbol)) {
      entry.figma = { component: symbol };
      delete entry.pending;
      flipped.push([entry.id, symbol]);
    }
  }
  if (flipped.length) writeJson(mapPath, cmap);
  return flipped;
}

/**
 * How often each mapped component is called in the code, keyed by Figma name.
 * This — not instances in the Product file — decides whether a divergence can
 * break anything: mocks say whether the drawings use it, call sites say whether
 * the product does.
 */
function codeUsage(config, cmap) {
  const u = config.usage;
  const symbols = {};
  for (const e of cmap.components || []) {
    const c = e.code || e.swift || {};
    const sym = c.export || c.symbol;
    if (sym) for (const n of figmaNames(e)) symbols[n] = sym;
  }
  const ignore = ['node_modules', 'build', '.git', ...(u.ignore || [])];
  const files = u.roots.flatMap((r) => walkFiles(path.resolve(config.root, r), u.extensions, ignore));
  const text = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const uses = {};
  for (const [figmaName, sym] of Object.entries(symbols)) {
    const re = new RegExp(u.pattern.split('{sym}').join(escapeRe(sym)), 'g');
    // the declaration is not a use of it
    const decl = u.declPattern ? new RegExp(u.declPattern.split('{sym}').join(escapeRe(sym)), 'gm') : null;
    uses[figmaName] = Math.max(0, (text.match(re) || []).length - (decl ? (text.match(decl) || []).length : 0));
  }
  return uses;
}

/**
 * A `Design-drift:` line waives the gate, and says why in git. It must NAME the
 * components it waives — prose that merely mentions the mechanism would
 * otherwise wave through a real divergence.
 */
function acknowledgement(root, blocking, messageFile) {
  let msg = '';
  try {
    msg = messageFile
      ? fs.readFileSync(messageFile, 'utf8')
      : execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  } catch {
    return { reason: null, named: [] };
  }
  for (const line of msg.split(/\r?\n/)) {
    if (!line.trim().toLowerCase().startsWith('design-drift:')) continue;
    const reason = line.split(':').slice(1).join(':').trim();
    const lower = reason.toLowerCase();
    // Lookarounds, not \b: a name that starts or ends with a non-word character
    // (`Button (legacy)`, `Icon/`) has no word boundary there and could never be waived.
    const named = blocking.filter((n) => new RegExp(`(?<![\\w])${escapeRe(n.toLowerCase())}(?![\\w])`).test(lower));
    if (named.length) return { reason, named };
    if (reason) console.error(`figma-code-sync: ignoring a Design-drift line that names none of the blocking components — ${JSON.stringify(reason)}`);
  }
  return { reason: null, named: [] };
}

function parseArgs(argv) {
  const i = argv.indexOf('--message-file');
  const args = {
    check: argv.includes('--check'),
    block: argv.includes('--block'),
    soft: argv.includes('--soft'),
    messageFile: i >= 0 ? argv[i + 1] : null,
  };
  // `--block` alone would fall into the WRITE path and rewrite the snapshot —
  // the opposite of gating. Refuse rather than guess.
  if (args.block && !args.check) throw new Error('--block only makes sense with --check (snapshot --check --block)');
  if (i >= 0 && !args.messageFile) throw new Error('--message-file needs a path');
  return args;
}

async function run(config, argv, { fetchImpl = globalThis.fetch } = {}) {
  const args = parseArgs(argv);
  const say = (m) => console.log('figma-code-sync snapshot: ' + m);
  const skip = (m) => {
    if (!args.soft) throw new Error(m);
    say(`skipped — ${m}`);
    return 0;
  };
  const snapPath = path.resolve(config.root, config.paths.snapshot);
  const mapPath = path.resolve(config.root, config.paths.map);
  if (!fs.existsSync(snapPath)) return skip(`${rel(config.root, snapPath)} does not exist; this refreshes a snapshot, it does not create one`);
  const current = readJson(snapPath);
  if (!current.fileKey) return skip(`${rel(config.root, snapPath)} has no fileKey yet — set it to the published Library's file key`);
  const token = figmaToken();
  if (!token) return skip('set FIGMA_TOKEN (or ~/.figma-token) to a personal access token with file_content:read and library_content:read');

  let result;
  try {
    result = await build(token, current, fetchImpl);
  } catch (e) {
    if (e instanceof SoftFail) return skip(e.message);
    throw e;
  }
  const { components, added, removed, changed, byName, duplicates } = result;
  const same = !(added.length || removed.length || changed.length);
  for (const d of duplicates) say(`warning: the Library publishes more than one component named ${JSON.stringify(d)} — name identity needs exactly one`);

  if (!args.check) {
    const identical = current.hashVersion === HASH_VERSION && JSON.stringify(current.components || []) === JSON.stringify(components);
    if (!identical) {
      const updated = { ...current, hashVersion: HASH_VERSION, capturedAt: new Date().toISOString(), components };
      fs.writeFileSync(snapPath, stringify(updated), 'utf8');
      say(`wrote ${rel(config.root, snapPath)} (${components.length} components)${same ? ' — field updates only, no divergence' : ''}`);
    } else say('snapshot already current');
    // Every published name, not only the newly published ones: a pending entry
    // written AFTER its component was already in the snapshot is paid off too.
    for (const [id, sym] of payOffPending(mapPath, new Set(byName.keys()))) {
      say(`${id} now points at the ${sym} component; it had been waiting as figma: null`);
    }
    return 0;
  }

  const legacy = current.hashVersion !== HASH_VERSION;
  if (legacy) say(`the snapshot's fingerprints are in another format (${current.hashVersion || 'unversioned'}); comparing without them — refresh once to rewrite them`);
  if (same) {
    say('snapshot matches the published library');
    return 0;
  }

  const uses = codeUsage(config, readJson(mapPath, { components: [] }));
  const was = new Map((current.components || []).map((c) => [c.name, c]));
  const advisory = [];
  const needsWork = [];
  for (const [name, why] of [...added.map((n) => [n, 'added']), ...removed.map((n) => [n, 'removed']), ...changed.map((n) => [n, 'changed'])]) {
    const used = uses[name] || 0;
    const lg = legacy || !(was.get(name) || {}).shape;
    const additive = isAdditive(comparable(was.get(name), lg) || {}, comparable(byName.get(name), lg) || {}, why);
    (additive || used === 0 ? advisory : needsWork).push({ name, why, used, additive });
  }
  const report = (items) => {
    for (const { name, why, used, additive } of items) {
      const where = used === 0 ? 'no code calls it yet' : `${used} use${used === 1 ? '' : 's'} in code`;
      console.log(`  ${name.padEnd(26)} ${why.padEnd(8)} ${where}${additive && why !== 'added' ? ' · additive' : ''}`);
      for (const s of describe(was.get(name), byName.get(name))) console.log(`      ${s}`);
    }
  };
  if (advisory.length) {
    console.log('Advisory — nothing that calls these can break:');
    report(advisory);
    console.log();
  }
  if (needsWork.length) {
    console.log('Needs resolving — these change something the code already calls:');
    report(needsWork);
    console.log();
  }
  if (!needsWork.length) {
    say('nothing the code calls has changed shape. Refresh the snapshot when you are ready.');
    return 0;
  }
  const names = needsWork.map((b) => b.name);
  const { reason, named } = acknowledgement(config.root, names, args.messageFile);
  if (reason && names.every((n) => named.includes(n))) {
    say(`acknowledged — ${reason}`);
    return 0;
  }
  if (reason) say(`the message waives ${named.join(', ')}, but not ${names.filter((n) => !named.includes(n)).join(', ')}`);
  console.log(
    'figma-code-sync: the published Library has moved under components the code calls.\n\n' +
      '  If Figma is right, bring the code to it, then refresh the snapshot.\n' +
      '  If the code is right, the Library needs the change instead.\n' +
      '  If you have looked and it is fine either way, say so in the commit message, naming each one:\n' +
      `      Design-drift: ${names.slice(0, 2).join(', ')} — padding only, no API change\n`
  );
  if (!args.block) {
    say('warning only at this stage — this blocks at the gate.');
    return 0;
  }
  return 1;
}

module.exports = { HASH_VERSION, comparable, run, build, shapeOf, fromDocument, describe, isAdditive, figmaNames, payOffPending, codeUsage, acknowledgement, newest };
