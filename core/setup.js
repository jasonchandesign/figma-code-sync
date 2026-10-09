'use strict';
/**
 * Guided setup (`init`) and `status`.
 *
 * `init` takes a project from any starting state to a working one in one pass:
 *
 *   1. detect   which adapter fits (a Tailwind v4 stylesheet, a Swift app) and where the token source is
 *   2. scaffold config, design/, hooks, CI — never overwriting without --force
 *   3. token    a Figma personal access token in ~/.figma-token (prompted, hidden; or skipped)
 *   4. library  the Library (and Product) file keys, verified against the API when a token exists
 *   5. tokens   generate the token file and say what came out
 *   6. snapshot read the published Library, pay off pending map entries
 *   7. seed     design-first: offer to seed the map from what the Library already publishes
 *   8. hooks    core.hooksPath + the executable bit
 *   9. status   where the project stands, and the next step
 *
 * Every step is idempotent, so re-running `init` resumes an interrupted setup.
 * Prompts and the network are injectable (`ask`, `fetchImpl`) so tests drive the
 * same code without a TTY or Figma.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { readJson, writeJson, figmaToken, walkFiles, rel } = require('./util');

const PKG = path.resolve(__dirname, '..');
const CONFIG = 'figma-sync.config.js';
const ADAPTERS = ['css-tailwind4', 'swift'];
const API = 'https://api.figma.com/v1';
const FILE_KEY = /^[0-9A-Za-z]{22,128}$/;

const tpl = (name) => fs.readFileSync(path.join(PKG, 'templates', name), 'utf8');

/** A question on the terminal; '' when there is no TTY. `hidden` never echoes. */
function askOnTty(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(question); };
  return new Promise((resolve) => rl.question(question, (a) => {
    rl.close();
    if (hidden) process.stdout.write('\n');
    resolve(a.trim());
  }));
}

function parseArgs(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  return {
    adapter: get('--adapter'),
    force: argv.includes('--force'),
    yes: argv.includes('--yes') || argv.includes('-y'),
    library: get('--library'),
    product: get('--product'),
    noToken: argv.includes('--no-token'),
    seed: argv.includes('--seed') ? true : argv.includes('--no-seed') ? false : null,
    noHooks: argv.includes('--no-hooks'),
  };
}

/** A Figma URL or a bare key → the key, or null. */
function fileKeyOf(input) {
  if (!input) return null;
  const m = /figma\.com\/(?:design|file|board)\/([0-9A-Za-z]{22,128})/.exec(input);
  if (m) return m[1];
  return FILE_KEY.test(input.trim()) ? input.trim() : null;
}

// ── 1. detect ──────────────────────────────────────────────────────────────

function detect(cwd) {
  const css = walkFiles(cwd, ['.css'], ['node_modules', 'build', 'dist', '.git', 'coverage'])
    .filter((f) => f.split(path.sep).length - cwd.split(path.sep).length <= 4)
    .find((f) => /@import\s+["']tailwindcss["']/.test(fs.readFileSync(f, 'utf8')));
  if (css) return { adapter: 'css-tailwind4', source: rel(cwd, css), why: `found ${rel(cwd, css)} importing tailwindcss` };
  const swift = fs.readdirSync(cwd).some((f) => f.endsWith('.xcodeproj') || f === 'Package.swift');
  if (swift) return { adapter: 'swift', source: 'design/tokens.json', why: 'found an Xcode project / Package.swift' };
  return { adapter: null, source: null, why: 'no Tailwind v4 stylesheet or Swift project found' };
}

// ── 2. scaffold ────────────────────────────────────────────────────────────

function place(cwd, relPath, content, { force, mode, log }) {
  const dest = path.resolve(cwd, relPath);
  if (fs.existsSync(dest) && !force) { log(`  kept     ${relPath}`); return false; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  if (mode) fs.chmodSync(dest, mode);
  log(`  created  ${relPath}`);
  return true;
}

function scaffold(cwd, adapter, source, { force, log }) {
  let config = tpl(`config.${adapter}.js`);
  if (adapter === 'css-tailwind4' && source) config = config.replace("source: 'src/index.css'", `source: '${source}'`);
  place(cwd, CONFIG, config, { force, log });
  place(cwd, 'design/component-map.json', tpl('component-map.json'), { force, log });
  place(cwd, 'design/figma-components.json', tpl('figma-components.json'), { force, log });
  place(cwd, 'design/WORKFLOW.md', tpl('WORKFLOW.md'), { force, log });
  if (adapter === 'swift') place(cwd, 'design/tokens.json', tpl('tokens.swift.json'), { force, log });
  place(cwd, 'scripts/githooks/pre-commit', tpl('githooks/pre-commit'), { force, mode: 0o755, log });
  place(cwd, 'scripts/githooks/commit-msg', tpl('githooks/commit-msg'), { force, mode: 0o755, log });
  place(cwd, '.github/workflows/design-sync.yml', tpl('github/design-sync.yml'), { force, log });
}

// ── 3. token ───────────────────────────────────────────────────────────────

function saveToken(token, home = os.homedir()) {
  const file = path.join(home, '.figma-token');
  fs.writeFileSync(file, token.trim(), { encoding: 'utf8', mode: 0o600 });
  return file;
}

// ── 4. library ─────────────────────────────────────────────────────────────

/** GET /files/:key?depth=1 → { ok, name } | { ok:false, status, hint }. Never logs the token. */
async function verifyAccess(key, token, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${API}/files/${key}?depth=1`, { headers: { 'X-Figma-Token': token } });
  } catch (e) {
    return { ok: false, status: 0, hint: `cannot reach the Figma API (${e.message})` };
  }
  if (res.ok) {
    const body = await res.json();
    return { ok: true, name: body.name };
  }
  const hint = res.status === 403 ? 'the token cannot read this file — wrong token, or missing the file_content:read scope'
    : res.status === 404 ? 'no file with that key, or the token has no access to its team'
      : `HTTP ${res.status}`;
  return { ok: false, status: res.status, hint };
}

// ── 7. seed ────────────────────────────────────────────────────────────────

/** Design-first: one map entry per published component, each waiting for its code. */
function seedFromSnapshot(snapshot, cmap) {
  const existing = new Set((cmap.components || []).flatMap((e) => [e.id, ...(e.figma ? (e.figma.components || [e.figma.component]) : [])]));
  const icons = cmap.icons || { figma: { prefix: 'Icon/' }, values: {} };
  const prefix = icons.figma && icons.figma.prefix;
  const added = [];
  for (const c of snapshot.components || []) {
    if (prefix && c.name.startsWith(prefix)) {
      const key = c.name.slice(prefix.length);
      if (!(key in icons.values)) { icons.values[key] = key; added.push(c.name); }
      continue;
    }
    if (existing.has(c.name)) continue;
    const axes = {};
    for (const [axis, values] of Object.entries(c.axes || {})) {
      axes[axis] = { prop: axis.charAt(0).toLowerCase() + axis.slice(1), values: Object.fromEntries(values.map((v) => [v, v])) };
    }
    const properties = {};
    for (const [prop, type] of Object.entries(c.properties || {})) properties[prop] = { type, code: prop.toLowerCase() };
    cmap.components.push({
      id: c.name,
      figma: { component: c.name },
      code: { symbol: c.name, file: '', kind: 'component', pending: 'published in the Library, not built in code yet' },
      axes, properties, slots: {}, allowRaw: [], notes: 'seeded from the published Library by figma-code-sync init — fill in code.file and the prop mappings',
    });
    added.push(c.name);
  }
  cmap.icons = icons;
  return added;
}

// ── 8. hooks ───────────────────────────────────────────────────────────────

function enableHooks(cwd) {
  execFileSync('git', ['config', 'core.hooksPath', 'scripts/githooks'], { cwd, stdio: 'ignore' });
  // Git skips a hook that is not executable, and Windows cannot set that bit on
  // disk — so set it in the index, where it travels to every clone. A no-op
  // until the hooks are tracked.
  for (const hook of ['scripts/githooks/pre-commit', 'scripts/githooks/commit-msg']) {
    try { execFileSync('git', ['update-index', '--chmod=+x', hook], { cwd, stdio: 'ignore' }); } catch { /* not tracked yet */ }
  }
}

// ── 9. status ──────────────────────────────────────────────────────────────

/**
 * Where a project stands. Pure: reads files, never the network.
 *   state: 'unconfigured' | 'code-first' | 'design-first' | 'unseeded' | 'diverged' | 'in-step' | 'in-sync'
 */
function status(config, opts = {}) {
  const check = require('./check');
  const R = (p) => path.resolve(config.root, p);
  const token = Boolean(figmaToken(opts.home));
  const snap = readJson(R(config.paths.snapshot), null) || {};
  const cmap = readJson(R(config.paths.map), null) || { components: [] };
  const entries = cmap.components || [];
  const published = (snap.components || []).filter((c) => !(cmap.icons && cmap.icons.figma && cmap.icons.figma.prefix && c.name.startsWith(cmap.icons.figma.prefix)));
  const awaitingFigma = entries.filter((e) => e.figma == null).length;
  const awaitingCode = entries.filter((e) => (e.code || e.swift || {}).pending).length;
  const result = check.run(config, opts.checkOpts || {});
  const tokensOut = R(config.tokens.out);

  let state, next;
  if (!snap.fileKey) {
    state = 'code-first';
    next = 'Build the Library from design/tokens.json (Claude: /figma-code-sync:figma-workflow), publish it, then `figma-code-sync init --library <url>` to connect it.';
  } else if (!published.length) {
    state = 'code-first';
    next = token ? 'The Library has nothing published yet. Publish it, then run `figma-code-sync snapshot`.' : 'Add a Figma token (~/.figma-token) so the published Library can be read, then `figma-code-sync snapshot`.';
  } else if (!entries.length) {
    state = 'unseeded';
    next = 'The Library is published but the map is empty. Run `figma-code-sync init --seed` to seed it from the Library (design-first), or add entries for your code components.';
  } else if (result.errors.length) {
    state = 'diverged';
    next = `Resolve the ${result.errors.length} finding(s) below — each names the side that moved.`;
  } else if (awaitingCode && !awaitingFigma) {
    state = 'design-first';
    next = `${awaitingCode} component(s) exist in Figma and not in code yet. Build them (Workflow A), then drop their code.pending.`;
  } else if (awaitingFigma || awaitingCode) {
    state = 'in-step';
    next = `${awaitingFigma} awaiting Figma, ${awaitingCode} awaiting code. Draw / build them; publish; \`figma-code-sync snapshot\` pays off the Figma side by name.`;
  } else {
    state = 'in-sync';
    next = 'Run `figma-code-sync snapshot --check` after any Figma publish, and `/figma-code-sync:design-audit` before one.';
  }
  return {
    state, next,
    token, fileKey: snap.fileKey || null, productFileKey: snap.productFileKey || null,
    capturedAt: snap.capturedAt || null, published: published.length,
    entries: entries.length, awaitingFigma, awaitingCode,
    tokensFresh: fs.existsSync(tokensOut) && require('./tokens').check(config).fresh,
    errors: result.errors, warnings: result.warnings,
  };
}

function printStatus(s, log = console.log) {
  const yn = (b) => (b ? 'yes' : 'no');
  log(`figma-code-sync status: ${s.state}`);
  log(`  token          ${yn(s.token)}${s.token ? '' : '  (FIGMA_TOKEN or ~/.figma-token)'}`);
  log(`  library        ${s.fileKey || 'not connected'}${s.productFileKey ? `  (product ${s.productFileKey})` : ''}`);
  log(`  snapshot       ${s.published} published component(s)${s.capturedAt ? `, captured ${s.capturedAt}` : ''}`);
  log(`  tokens         ${s.tokensFresh ? 'fresh' : 'stale or missing — run `figma-code-sync tokens`'}`);
  log(`  map            ${s.entries} entr${s.entries === 1 ? 'y' : 'ies'}, ${s.awaitingFigma} awaiting Figma, ${s.awaitingCode} awaiting code`);
  log(`  check          ${s.errors.length} error(s), ${s.warnings.length} warning(s)`);
  for (const line of s.errors.slice(0, 20)) log(`    ${line}`);
  if (s.errors.length > 20) log(`    … ${s.errors.length - 20} more (run \`figma-code-sync check\`)`);
  log(`  next           ${s.next}`);
}

// ── init ───────────────────────────────────────────────────────────────────

async function init({ cwd = process.cwd(), argv = [], ask = askOnTty, fetchImpl = globalThis.fetch, log = console.log, home = os.homedir() } = {}) {
  const a = parseArgs(argv);
  const interactive = !a.yes && process.stdin.isTTY && ask === askOnTty;
  const q = async (question, opts) => (a.yes ? '' : ask(question, opts));
  const yes = async (question, dflt = true) => {
    if (a.yes) return dflt;
    const r = (await ask(`${question} [${dflt ? 'Y/n' : 'y/N'}] `)).toLowerCase();
    return r ? r.startsWith('y') : dflt;
  };

  // 1. detect
  log('figma-code-sync init');
  const d = detect(cwd);
  let adapter = a.adapter;
  if (adapter && !ADAPTERS.includes(adapter)) throw new Error(`unknown adapter ${adapter} — ${ADAPTERS.join(' or ')}`);
  if (!adapter) {
    adapter = d.adapter;
    if (adapter) log(`\n1/9 detect     ${adapter} (${d.why})`);
    else {
      log(`\n1/9 detect     ${d.why}`);
      const r = await q(`    Adapter? css-tailwind4 (stylesheet is the truth) or swift (tokens.json is the truth) [css-tailwind4]: `);
      adapter = ADAPTERS.includes(r) ? r : 'css-tailwind4';
    }
  } else log(`\n1/9 detect     ${adapter} (--adapter)`);

  // 2. scaffold
  log('\n2/9 scaffold');
  scaffold(cwd, adapter, d.adapter === adapter ? d.source : null, { force: a.force, log });
  const config = require('./config').loadConfig(cwd);
  const snapPath = path.resolve(config.root, config.paths.snapshot);
  const mapPath = path.resolve(config.root, config.paths.map);

  // 3. token
  log('\n3/9 token');
  let token = figmaToken(home);
  if (token) log('    found (FIGMA_TOKEN or ~/.figma-token)');
  else if (a.noToken) log('    skipped (--no-token)');
  else {
    log('    A Figma personal access token lets the CLI read the published Library.');
    log('    Figma → Settings → Security → Personal access tokens; scopes file_content:read + library_content:read.');
    const t = await q('    Paste the token (input is hidden; Enter to skip): ', { hidden: true });
    if (t) { const f = saveToken(t, home); token = t; log(`    saved to ${f} (mode 600). Never commit it.`); }
    else log(`    skipped — later: save it to ${path.join(home, '.figma-token')} and re-run init`);
  }

  // 4. library
  log('\n4/9 library');
  const snap = readJson(snapPath);
  let libInput = a.library;
  if (!libInput && !snap.fileKey) libInput = await q('    Library file URL or key (Enter to skip — code-first, connect it after the first publish): ');
  if (libInput) {
    const key = fileKeyOf(libInput);
    if (!key) log(`    "${libInput}" is not a Figma file URL or key — skipped`);
    else { snap.fileKey = key; log(`    library  ${key}`); }
  } else if (snap.fileKey) log(`    library  ${snap.fileKey} (already set)`);
  else log('    skipped — code-first');
  let prodInput = a.product;
  if (!prodInput && snap.fileKey && !snap.productFileKey) prodInput = await q('    Product file URL or key (optional, Enter to skip): ');
  if (prodInput) { const k = fileKeyOf(prodInput); if (k) { snap.productFileKey = k; log(`    product  ${k}`); } }
  writeJson(snapPath, snap);
  let access = null;
  if (snap.fileKey && token) {
    access = await verifyAccess(snap.fileKey, token, fetchImpl);
    log(access.ok ? `    verified: "${access.name}" is readable with this token` : `    cannot verify: ${access.hint}`);
  } else if (snap.fileKey) log('    not verified (no token)');

  // 5. tokens
  log('\n5/9 tokens');
  const tokens = require('./tokens');
  try {
    const { out, errors } = tokens.write(config);
    errors.forEach((e) => log(`    error ${e}`));
    if (adapter === 'css-tailwind4') {
      const doc = readJson(out);
      const n = (g) => Object.keys(doc[g] || {}).length;
      log(`    wrote ${rel(config.root, out)} — ${n('color')} colours (${(doc.$extensions['figma-code-sync'].modes || []).join('/')}), ${n('radius')} radii, ${n('spacing')} spacing steps, ${n('font')} fonts`);
      if (!n('spacing')) log('    no spacing scale: declare `@theme { --spacing: 0.25rem; }` in the stylesheet so components can bind to spacing/* (docs/adapters.md)');
    } else log(`    wrote ${rel(config.root, out)}`);
  } catch (e) {
    log(`    could not generate: ${e.message}`);
    log(`    fix tokens.source / tokens.out in ${CONFIG}, then run \`figma-code-sync tokens\``);
  }

  // 6. snapshot
  log('\n6/9 snapshot');
  let refreshed = false;
  if (snap.fileKey && token && (!access || access.ok)) {
    try {
      const snapshot = require('./snapshot');
      const quiet = (m) => log('    ' + m.replace(/^figma-code-sync snapshot: /, ''));
      const saved = console.log; console.log = quiet;
      try { await snapshot.run(config, [], { fetchImpl }); } finally { console.log = saved; }
      refreshed = true;
    } catch (e) { log(`    failed: ${e.message.split('\n')[0]}`); }
  } else log('    skipped — needs a library key and a token');

  // 7. seed
  log('\n7/9 seed');
  const snapNow = readJson(snapPath);
  const cmap = readJson(mapPath);
  const prefix = cmap.icons && cmap.icons.figma && cmap.icons.figma.prefix;
  const publishedComponents = (snapNow.components || []).filter((c) => !(prefix && c.name.startsWith(prefix)));
  const unmapped = publishedComponents.filter((c) => !(cmap.components || []).some((e) => e.id === c.name || (e.figma && (e.figma.component === c.name || (e.figma.components || []).includes(c.name)))));
  if (!unmapped.length) log(refreshed ? '    nothing to seed — every published component has a map entry' : '    nothing published to seed from');
  else {
    const want = a.seed != null ? a.seed : await yes(`    ${unmapped.length} published component(s) have no map entry. Seed entries for them (design-first: each waits for its code)?`, true);
    if (want) {
      const added = seedFromSnapshot(snapNow, cmap);
      writeJson(mapPath, cmap);
      log(`    seeded ${added.length} entr${added.length === 1 ? 'y' : 'ies'} — fill in each code.file and the axis → prop mappings as you build them`);
    } else log('    skipped — add map entries by hand (design/WORKFLOW.md), or re-run with --seed');
  }

  // 8. hooks
  log('\n8/9 hooks');
  if (a.noHooks) log('    skipped (--no-hooks)');
  else if (fs.existsSync(path.join(cwd, '.git'))) { try { enableHooks(cwd); log('    core.hooksPath = scripts/githooks (pre-commit checks, commit-msg warns)'); } catch (e) { log(`    could not enable: ${e.message}`); } }
  else log('    not a git repository yet — run `figma-code-sync hooks` after `git init`');
  if (!fs.existsSync(path.join(cwd, 'node_modules', '.bin', 'figma-code-sync'))) {
    log('    the hooks look for a local install: npm i -D github:jasonchandesign/figma-code-sync#v0.1.0');
  }

  // 9. status
  log('\n9/9 status');
  const s = status(config, { home });
  printStatus(s, (line) => log('  ' + line));
  if (!interactive && !a.yes) log('\n(no TTY: prompts were skipped — pass --library, --product, --seed, or re-run in a terminal)');
  return { config, status: s, adapter };
}

module.exports = { init, status, printStatus, detect, fileKeyOf, seedFromSnapshot, verifyAccess, saveToken, enableHooks, scaffold, parseArgs };
