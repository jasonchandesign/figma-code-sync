'use strict';
/**
 * End-to-end scenarios: a project in every starting state is onboarded with the
 * same `init` a person runs, against a FAKE Figma REST API, and the gates are
 * checked for the right verdicts. No network, no TTY.
 *
 *   code-only      code exists, nothing in Figma yet
 *   design-first   a published Library, no code yet
 *   half-synced    both exist and disagree on names, values and completeness
 *   the gate       rename / re-pad / add-variant / waiver / corrupt files
 *   packaging      `npm pack` → install the tarball → the bin runs
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const setup = require('../core/setup');
const snapshot = require('../core/snapshot');
const check = require('../core/check');
const { loadConfig } = require('../core/config');

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';

// ── a fake Figma ───────────────────────────────────────────────────────────

/**
 * components: [{ name, axes?: {Axis: [values]}, props?: {Prop: 'TEXT'}, pad?: [t,r,b,l], gap?, page? }]
 * A component with axes is a COMPONENT_SET; without, a standalone COMPONENT.
 */
function fakeFigma(components, { fileName = 'Fake Library', status = {} } = {}) {
  let n = 1;
  const id = () => `${n++}:${n++}`;
  const sets = [];
  const comps = [];
  const canvases = {};
  for (const c of components) {
    const page = c.page || 'Components';
    // padding/gap live on the VARIANT components (a set is a plain container), as in Figma
    const geometry = () => ({ paddingTop: (c.pad || [0, 0, 0, 0])[0], paddingRight: (c.pad || [0, 0, 0, 0])[1], paddingBottom: (c.pad || [0, 0, 0, 0])[2], paddingLeft: (c.pad || [0, 0, 0, 0])[3],
      itemSpacing: c.gap || 0, layoutMode: 'HORIZONTAL', absoluteBoundingBox: { width: 100, height: 32 }, fills: [], strokes: [] });
    const node = { type: c.axes ? 'COMPONENT_SET' : 'COMPONENT', name: c.name, id: id(), componentPropertyDefinitions: {}, ...(c.axes ? { fills: [], strokes: [] } : geometry()), children: [] };
    for (const [axis, values] of Object.entries(c.axes || {})) node.componentPropertyDefinitions[axis] = { type: 'VARIANT', variantOptions: values };
    for (const [prop, type] of Object.entries(c.props || {})) node.componentPropertyDefinitions[`${prop}#1:1`] = { type };
    if (c.axes) {
      sets.push({ node_id: node.id, key: `key-${c.name}`, name: c.name, updated_at: c.updatedAt || '2026-01-01T00:00:00Z' });
      const [axis, values] = Object.entries(c.axes)[0];
      for (const v of values) {
        const vid = id();
        node.children.push({ type: 'COMPONENT', name: `${axis}=${v}`, id: vid, ...geometry(), children: [] });
        comps.push({ node_id: vid, key: `key-${c.name}-${v}`, name: `${axis}=${v}`, updated_at: c.updatedAt || '2026-01-01T00:00:00Z', containing_frame: { containingComponentSet: { nodeId: node.id } } });
      }
    } else comps.push({ node_id: node.id, key: `key-${c.name}`, name: c.name, updated_at: c.updatedAt || '2026-01-01T00:00:00Z' });
    (canvases[page] = canvases[page] || []).push(node);
  }
  const doc = { name: fileName, document: { type: 'DOCUMENT', children: Object.entries(canvases).map(([name, children]) => ({ type: 'CANVAS', name, children })) } };
  const json = (body, code = 200) => Promise.resolve({ ok: code < 400, status: code, json: async () => body, text: async () => JSON.stringify(body) });
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push(url);
    assert.equal((opts.headers || {})['X-Figma-Token'], 'fake-token', 'the token travels only as X-Figma-Token');
    if (status.all) return json({ status: status.all, err: 'nope' }, status.all);
    if (url.endsWith(`/files/${KEY}/component_sets`)) return json({ meta: { component_sets: sets } });
    if (url.endsWith(`/files/${KEY}/components`)) return json({ meta: { components: comps } });
    if (url.includes(`/files/${KEY}`)) return json(doc);
    return json({ status: 404, err: 'Not found' }, 404);
  };
  return { fetchImpl, calls };
}

// ── a project ──────────────────────────────────────────────────────────────

function project({ code = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-scn-'));
  const home = path.join(dir, '.home');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.css'), [
    '@import "tailwindcss";', '@theme { --spacing: 0.25rem; }',
    '@theme inline { --color-background: var(--background); --color-primary: var(--primary); --radius-lg: var(--radius); --font-sans: "Inter Variable"; }',
    ':root { --background: #ffffff; --primary: #d97706; --radius: 0.5rem; }', '.dark { --background: #000000; --primary: #d97706; }',
  ].join('\n'));
  for (const [name, { variants = ['default'], uses = 0 }] of Object.entries(code)) {
    fs.writeFileSync(path.join(dir, 'src', 'components', `${name}.jsx`), `export const ${name.toUpperCase()}_VARIANTS = ${JSON.stringify(variants)};\nexport function ${name}() { return null; }\n`);
    if (uses) fs.writeFileSync(path.join(dir, 'src', `${name}Screen.jsx`), `import { ${name} } from './components/${name}';\nexport default () => <>${`<${name} />`.repeat(uses)}</>;\n`);
  }
  return { dir, home };
}

/** Run `init` the way a person would, with answers scripted. */
async function onboard(p, { argv = [], answers = {}, figma, token = true } = {}) {
  const log = [];
  if (token) process.env.FIGMA_TOKEN = 'fake-token'; else delete process.env.FIGMA_TOKEN;
  const ask = async (q) => { const k = Object.keys(answers).find((k) => q.includes(k)); return k ? answers[k] : ''; };
  const r = await setup.init({ cwd: p.dir, argv: ['--no-hooks', ...argv], ask, fetchImpl: figma ? figma.fetchImpl : async () => { throw new Error('offline'); }, log: (l) => log.push(l), home: p.home });
  return { ...r, log: log.join('\n') };
}
const roster = (code) => Object.fromEntries(Object.entries(code).map(([n, { variants = ['default'] }]) => [n, { file: `src/components/${n}.jsx`, props: { variant: variants } }]));
const quiet = async (fn) => { const saved = console.log; const out = []; console.log = (...a) => out.push(a.join(' ')); try { return [await fn(), out.join('\n')]; } finally { console.log = saved; } };
const mapOf = (p) => JSON.parse(fs.readFileSync(path.join(p.dir, 'design/component-map.json'), 'utf8'));
const writeMap = (p, m) => fs.writeFileSync(path.join(p.dir, 'design/component-map.json'), JSON.stringify(m, null, 2));
const entry = (name, extra = {}) => ({ id: name, figma: { component: name }, code: { symbol: name, file: `src/components/${name}.jsx` }, axes: { Variant: { prop: 'variant', values: { default: 'default' } } }, properties: {}, slots: {}, allowRaw: [], ...extra });
const gate = (p, figma, argv = ['--check', '--block'], msg) => quiet(async () => {
  let messageFile = null;
  if (msg) { messageFile = path.join(p.dir, 'MSG'); fs.writeFileSync(messageFile, msg); argv = [...argv, '--message-file', messageFile]; }
  return snapshot.run(loadConfig(p.dir), argv, { fetchImpl: figma.fetchImpl });
});

// ── scenarios ──────────────────────────────────────────────────────────────

test('code-only: onboard without Figma, then connect the Library once it is published', async () => {
  const code = { Button: { variants: ['default', 'outline'], uses: 2 } };
  const p = project({ code });
  const r = await onboard(p, { argv: ['--yes'], token: false });
  assert.equal(r.adapter, 'css-tailwind4', 'detected from the stylesheet');
  assert.match(r.log, /1\/9 detect\s+css-tailwind4/);
  assert.match(r.log, /skipped — code-first/);
  assert.equal(r.status.state, 'code-first');
  assert.deepEqual(r.status.errors, []);
  assert.ok(fs.existsSync(path.join(p.dir, 'design/tokens.json')) && !fs.existsSync(path.join(p.home, '.figma-token')));

  // the team records what Figma owes, before anything is drawn
  const m = mapOf(p);
  m.components.push(entry('Button', { figma: null, pending: 'not drawn yet', axes: { Variant: { prop: 'variant', values: { default: 'default', outline: 'outline' } } } }));
  writeMap(p, m);
  assert.deepEqual(check.run(loadConfig(p.dir), { roster: roster(code) }).errors, [], 'a pending entry is a warning, never an error');

  // the Library is published → init again with the URL pays the debt off by name
  const figma = fakeFigma([{ name: 'Button', axes: { Variant: ['default', 'outline'] }, pad: [0, 12, 0, 12] }]);
  const r2 = await onboard(p, { argv: ['--yes', '--library', `https://www.figma.com/design/${KEY}/Lib?node-id=0-1`], figma });
  assert.match(r2.log, /verified: "Fake Library"/);
  assert.match(r2.log, /Button now points at the Button component/);
  assert.equal(mapOf(p).components[0].figma.component, 'Button');
  assert.equal(r2.status.state, 'in-sync');
  assert.deepEqual(check.run(loadConfig(p.dir), { roster: roster(code) }).errors, []);
});

test('design-first: a published Library and no code — seed the map, then build the code', async () => {
  const p = project();
  const figma = fakeFigma([
    { name: 'Button', axes: { Variant: ['default', 'ghost'] }, props: { Label: 'TEXT' } },
    { name: 'Badge' },
    { name: 'Icon/plus', page: 'Icons' },
  ]);
  const r = await onboard(p, { argv: ['--yes', '--library', KEY, '--seed'], figma });
  assert.match(r.log, /seeded 3 entries/);
  const m = mapOf(p);
  assert.deepEqual(m.components.map((e) => e.id).sort(), ['Badge', 'Button']);
  assert.deepEqual(m.icons.values, { plus: 'plus' });
  const b = m.components.find((e) => e.id === 'Button');
  assert.deepEqual(b.axes.Variant.values, { default: 'default', ghost: 'ghost' });
  assert.equal(b.properties.Label.type, 'TEXT');
  assert.ok(b.code.pending);
  assert.equal(r.status.state, 'design-first');
  assert.deepEqual(r.status.errors, [], 'nothing built yet is debt, not drift');
  // the code side's roster is empty — pending entries must not be "not in the roster"
  assert.deepEqual(check.run(loadConfig(p.dir), { roster: {} }).errors, []);

  // build Button in code, drop the debt
  fs.writeFileSync(path.join(p.dir, 'src/components/Button.jsx'), "export const BUTTON_VARIANTS = ['default', 'ghost'];\nexport function Button() { return null; }\n");
  b.code = { symbol: 'Button', file: 'src/components/Button.jsx' };
  writeMap(p, m);
  const res = check.run(loadConfig(p.dir), { roster: { Button: { file: 'src/components/Button.jsx', props: { variant: ['default', 'ghost'] } } } });
  assert.deepEqual(res.errors, []);
  assert.equal(setup.status(loadConfig(p.dir)).state, 'design-first', 'Badge is still owed');
});

test('half-synced: names, values and completeness disagree — every disagreement is named', async () => {
  const code = { Button: { variants: ['default', 'ghost'] }, Chip: { variants: ['default', 'pill'] } };
  const p = project({ code });
  const figma = fakeFigma([
    { name: 'PrimaryButton', axes: { Variant: ['default', 'Ghost'] } }, // renamed + a value cased differently
    { name: 'badge', axes: { Variant: ['default'] }, props: { Icon: 'INSTANCE_SWAP' } }, // case mismatch + a property with no home
  ]);
  await onboard(p, { argv: ['--yes', '--library', KEY, '--no-seed'], figma });
  const m = mapOf(p);
  m.components.push(entry('Button', { axes: { Variant: { prop: 'variant', values: { default: 'default', ghost: 'ghost' } } } }));
  m.components.push(entry('Chip', { figma: { component: 'Badge' }, axes: { Variant: { prop: 'variant', values: { default: 'default', pill: 'pill' } } } }));
  writeMap(p, m);
  const res = check.run(loadConfig(p.dir), { roster: roster(code) });
  const msgs = res.errors.join('\n');
  assert.match(msgs, /PrimaryButton — Figma component has no entry/);
  assert.match(msgs, /badge — Figma component has no entry.*did you mean "Badge"/);
  assert.match(msgs, /Button — maps Figma component "Button" which is not in the snapshot/);
  assert.match(msgs, /Chip — maps Figma component "Badge" which is not in the snapshot — the Library has "badge"/);
  assert.equal(setup.status(loadConfig(p.dir)).state, 'diverged');
  // same, once the names are reconciled: value-level disagreements surface
  const figma2 = fakeFigma([{ name: 'Button', axes: { Variant: ['default', 'Ghost'] } }, { name: 'Badge', axes: { Variant: ['default'] }, props: { Icon: 'INSTANCE_SWAP' } }]);
  await gate(p, figma2, []);
  const res2 = check.run(loadConfig(p.dir), { roster: roster(code) });
  const m2 = res2.errors.join('\n');
  assert.match(m2, /Button — Variant=Ghost is not mapped/);
  assert.match(m2, /Button — maps Variant=ghost but Button has no such value/);
  assert.match(m2, /Chip — maps Variant=pill but Badge has no such value/);
  assert.match(m2, /Badge — INSTANCE_SWAP property "Icon" has no home/);
  assert.doesNotMatch(m2, /Chip — Variant maps to variant="pill"/, 'pill is in the code too, so the roster check has nothing to say');
  assert.equal(res2.errors.length, 4, 'and nothing else');
});

test('the gate: rename, re-pad, add a variant, waive, corrupt files', async () => {
  const code = { Button: { variants: ['default'], uses: 2 }, Badge: { variants: ['default'] } };
  const p = project({ code });
  const base = [{ name: 'Button', axes: { Variant: ['default'] }, pad: [0, 12, 0, 12] }, { name: 'Badge', axes: { Variant: ['default'] }, pad: [0, 8, 0, 8] }];
  await onboard(p, { argv: ['--yes', '--library', KEY, '--no-seed'], figma: fakeFigma(base) });
  writeMap(p, { ...mapOf(p), components: [entry('Button'), entry('Badge')] });
  await gate(p, fakeFigma(base), []); // refresh → in sync
  assert.equal((await gate(p, fakeFigma(base)))[0], 0, 'nothing moved');

  // re-pad Badge: nothing calls it → advisory
  const repad = [base[0], { ...base[1], pad: [0, 16, 0, 16], updatedAt: '2026-02-01T00:00:00Z' }];
  const [c1, o1] = await gate(p, fakeFigma(repad));
  assert.equal(c1, 0); assert.match(o1, /Advisory/); assert.match(o1, /variant Variant=default: padding \[0,8,0,8\] → \[0,16,0,16\]/);

  // re-pad Button: code calls it twice → blocks
  const repadUsed = [{ ...base[0], pad: [0, 16, 0, 16], updatedAt: '2026-02-01T00:00:00Z' }, base[1]];
  const [c2, o2] = await gate(p, fakeFigma(repadUsed));
  assert.equal(c2, 1); assert.match(o2, /Needs resolving/); assert.match(o2, /2 uses in code/);
  // …unless the commit names it
  assert.equal((await gate(p, fakeFigma(repadUsed), ['--check', '--block'], 'Tidy\n\nDesign-drift: Button — re-padded, code matches'))[0], 0);
  assert.equal((await gate(p, fakeFigma(repadUsed), ['--check', '--block'], 'Design-drift: IconButton — unrelated'))[0], 1, 'a similar name is not a waiver');
  // and --check without --block only warns
  assert.equal((await gate(p, fakeFigma(repadUsed), ['--check']))[0], 0);

  // rename Button → PrimaryButton: a removal of something the code calls → blocks
  const renamed = [{ ...base[0], name: 'PrimaryButton' }, base[1]];
  const [c3, o3] = await gate(p, fakeFigma(renamed));
  assert.equal(c3, 1); assert.match(o3, /Button\s+removed\s+2 uses/);

  // a new variant is additive → passes the gate; after a refresh, `check` demands a mapping
  const grown = [{ ...base[0], axes: { Variant: ['default', 'ghost'] }, updatedAt: '2026-03-01T00:00:00Z' }, base[1]];
  const [c4, o4] = await gate(p, fakeFigma(grown));
  assert.equal(c4, 0, o4); assert.match(o4, /additive/); assert.match(o4, /axis Variant \+ghost/); assert.match(o4, /\+variant Variant=ghost/);
  // …but a new variant PLUS a re-padded existing one is breaking, and the report names the variant
  const grownAndRepadded = [{ ...grown[0], pad: [0, 16, 0, 16] }, base[1]];
  const [c5, o5] = await gate(p, fakeFigma(grownAndRepadded));
  assert.equal(c5, 1); assert.match(o5, /variant Variant=default: padding/);
  await gate(p, fakeFigma(grown), []);
  assert.match(check.run(loadConfig(p.dir)).errors.join('\n'), /Variant=ghost is not mapped/);

  // --block alone must refuse, never rewrite
  await assert.rejects(gate(p, fakeFigma(grown), ['--block']), /--block only makes sense with --check/);

  // a corrupt snapshot or map is an error, never "nothing to compare"
  const snapPath = path.join(p.dir, 'design/figma-components.json');
  const good = fs.readFileSync(snapPath, 'utf8');
  fs.writeFileSync(snapPath, '{ not json');
  assert.match(check.run(loadConfig(p.dir)).errors.join('\n'), /cannot parse .*figma-components\.json/);
  fs.writeFileSync(snapPath, good);
  fs.writeFileSync(path.join(p.dir, 'design/component-map.json'), '{ not json');
  // a divergence must be on the table, or the map is never consulted
  await assert.rejects(gate(p, fakeFigma(grownAndRepadded)), /cannot parse .*component-map\.json/);
});

test('onboarding handles a bad token and a wrong key without leaking or crashing', async () => {
  const p = project();
  const figma = fakeFigma([], { status: { all: 403 } });
  const r = await onboard(p, { argv: ['--yes', '--library', KEY], figma });
  assert.match(r.log, /cannot verify: the token cannot read this file/);
  assert.match(r.log, /6\/9 snapshot\n\s+skipped/);
  assert.doesNotMatch(r.log, /fake-token/, 'the token is never printed');
  assert.equal(r.status.state, 'code-first');
  const r2 = await onboard(p, { argv: ['--yes', '--library', 'not-a-key'], figma });
  assert.match(r2.log, /is not a Figma file URL or key/);
});

test('onboarding saves a pasted token to the home dir with mode 600, and never into the repo', async () => {
  const p = project();
  const r = await onboard(p, { argv: ['--no-seed'], answers: { 'Paste the token': 'figd_secret', 'Library file URL': '' }, token: false });
  const f = path.join(p.home, '.figma-token');
  assert.equal(fs.readFileSync(f, 'utf8'), 'figd_secret');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.doesNotMatch(r.log, /figd_secret/);
  assert.ok(!fs.readdirSync(p.dir).some((n) => /token/.test(n)));
});

test('status --json and check --json are machine-readable', async () => {
  const p = project({ code: { Button: { variants: ['default'] } } });
  await onboard(p, { argv: ['--yes'], token: false });
  writeMap(p, { ...mapOf(p), components: [entry('Button', { figma: null, pending: 'not drawn' })] });
  const bin = path.join(__dirname, '..', 'bin', 'figma-code-sync.js');
  const run = (...a) => { try { return JSON.parse(execFileSync(process.execPath, [bin, ...a], { cwd: p.dir, encoding: 'utf8' })); } catch (e) { return JSON.parse(e.stdout); } };
  const s = run('status', '--json');
  assert.equal(s.state, 'code-first');
  assert.equal(s.awaitingFigma, 1);
  assert.equal(typeof s.next, 'string');
  const c = run('check', '--json');
  assert.equal(c.ok, true);
  assert.deepEqual(c.errors, []);
  assert.equal(c.warnings[0].where, 'design/component-map.json:Button');
});

test('packaging: npm pack → install the tarball → the bin runs with no dependencies', () => {
  const pkgDir = path.join(__dirname, '..');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-pack-'));
  const tgz = execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: pkgDir, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop();
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'fcs-app-'));
  fs.writeFileSync(path.join(app, 'package.json'), '{"name":"app","private":true}');
  execFileSync('npm', ['i', '--silent', '--no-audit', '--no-fund', path.join(out, tgz)], { cwd: app, encoding: 'utf8', shell: process.platform === 'win32' });
  const binDir = path.join(app, 'node_modules', '.bin');
  assert.ok(fs.existsSync(path.join(binDir, 'figma-code-sync')), 'bin is linked');
  const help = execFileSync(process.execPath, [path.join(app, 'node_modules', 'figma-code-sync', 'bin', 'figma-code-sync.js'), '--help'], { encoding: 'utf8' });
  assert.match(help, /guided setup/);
  const shipped = fs.readdirSync(path.join(app, 'node_modules', 'figma-code-sync'));
  assert.ok(['bin', 'core', 'adapters', 'templates', 'index.js', 'package.json', 'README.md', 'LICENSE'].every((f) => shipped.includes(f)), shipped.join(','));
  assert.ok(!shipped.includes('test') && !shipped.includes('plugin'), 'tests and the Claude plugin are not in the npm package');
  assert.ok(!fs.existsSync(path.join(app, 'node_modules', 'figma-code-sync', 'node_modules')), 'zero dependencies');
});
