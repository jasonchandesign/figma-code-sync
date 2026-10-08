// ── figma-code-sync build kit ──────────────────────────────────────────────
// Prepend this file to a `use_figma` script that builds or edits Library
// components. Everything is resolved by NAME — variables (`color/primary`,
// `radius/lg`, `spacing/3`), text styles, effect styles, icon components — so
// it works in any Library whose variables were written from design/tokens.json.
//
//   await kit.init({
//     fonts: [{ family: 'Inter', style: 'Regular' }, …],
//     iconPage: '<id of the Icons page>',              // needed before kit.icon()
//     // roles the kit uses by default — change them when the tokens aren't shadcn-shaped:
//     // defaults: { text: 'color/text/primary', icon: 'color/text/primary' },
//     // chrome: { fill: 'color/surface/base', stroke: 'color/border/default' },  // the set frame; raw grey if absent
//   });
//   const c = kit.comp('Badge');                       // auto-layout component
//   await kit.fill(c, 'color/primary', 0.1);           // bound paint, 10% wash
//   await kit.space(c, { px: 8, py: 2, gap: 4 });      // padding/gap bound to spacing/*
//   await kit.radius(c, 'radius/lg');                  // or 'full' (raw 9999 — list it in allowRaw)
//   c.appendChild(await kit.icon('plus', 16, 'color/primary'));
//   c.appendChild(await kit.text('Label', { size: 12, weight: 'Medium', color: 'color/primary' }));
//   const set = await kit.finish([c, …], 'Badge', 'Code: Badge — src/…', 'Size', page);
//   kit.state.binding[set.id];                         // { bound, offScale } from finish's autoBind
//   return await kit.audit(set);                       // anything left unbound
//
// The rules it encodes (each one cost real time to learn):
//   1. Assigning a variable-bound paint resets its opacity to 1 → bind, assign,
//      then reassign a copy with the opacity (setPaint).
//   2. Instances can still render bound paints at 100% → finish() runs
//      alphaPass: translucency moves onto the LAYER (node opacity, or a locked
//      full-size `wash` / `hairline` rectangle carrying the bound colour).
//   3. Every padding, gap and fixed size on the spacing scale is bound to a
//      `spacing/*` variable (bindSpacing). Off-scale values are reported, never
//      rounded — they are bugs, or they belong in the map's `allowRaw`.
//   4. A nested instance binds ONLY the fields it overrides. Binding an
//      inherited value turns it into an override that stops following its
//      main component.
//   5. Frames that hold components don't clip (shadows would be shaved).
// ───────────────────────────────────────────────────────────────────────────

const kit = (() => {
  const S = {
    vars: {}, spacing: {}, text: {}, effect: {}, icons: {}, ready: false,
    // role names the helpers fall back to; override in init() for a non-shadcn token shape
    defaults: { text: 'color/foreground', icon: 'color/foreground' },
    chrome: { fill: 'color/background', stroke: 'color/border' },
  };

  async function init({ fonts = [], iconPrefix = 'Icon/', iconPage = null, defaults = {}, chrome = {} } = {}) {
    Object.assign(S.defaults, defaults);
    Object.assign(S.chrome, chrome);
    for (const v of await figma.variables.getLocalVariablesAsync()) {
      S.vars[v.name] = v;
      if (v.name.startsWith('spacing/') && v.resolvedType === 'FLOAT') {
        const px = Object.values(v.valuesByMode)[0];
        if (typeof px === 'number') S.spacing[String(Math.round(px * 100) / 100)] = v;
      }
    }
    for (const s of await figma.getLocalTextStylesAsync()) S.text[s.name] = s;
    for (const s of await figma.getLocalEffectStylesAsync()) S.effect[s.name] = s;
    await Promise.all(fonts.map((f) => figma.loadFontAsync(f)));
    if (iconPage) {
      const page = await figma.getNodeByIdAsync(iconPage);
      await page.loadAsync();
      for (const n of page.findAllWithCriteria({ types: ['COMPONENT'] })) if (n.name.startsWith(iconPrefix)) S.icons[n.name.slice(iconPrefix.length)] = n;
    }
    S.ready = true;
    return { variables: Object.keys(S.vars).length, spacingSteps: Object.keys(S.spacing).length, icons: Object.keys(S.icons).length };
  }

  const need = (name) => {
    const v = S.vars[name];
    if (!v) throw new Error(`no variable named ${name} — push the tokens first`);
    return v;
  };

  // ── paint ──
  // A `#rrggbb` name is a deliberately RAW paint (a palette hue the theme has no
  // role for) — audit() still reports it, so it must be listed in `allowRaw`.
  const hex = (h) => { const n = parseInt(h.slice(1), 16); return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }; };
  const paint = (name) => (name.startsWith('#')
    ? { type: 'SOLID', color: hex(name) }
    : figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', need(name)));
  async function setPaint(node, prop, name, opacity) {
    node[prop] = [paint(name)];
    if (opacity != null && opacity !== 1) node[prop] = [{ ...node[prop][0], opacity }]; // rule 1
  }
  const fill = (node, name, opacity) => (name ? setPaint(node, 'fills', name, opacity) : ((node.fills = []), null));
  const SIDES = { t: 'strokeTopWeight', r: 'strokeRightWeight', b: 'strokeBottomWeight', l: 'strokeLeftWeight' };
  /** weight: a number (all sides) or { t, r, b, l } (missing sides = 0) — e.g. { b: 1 } for border-b. */
  async function stroke(node, name, opacity, weight = 1, align = 'INSIDE') {
    await setPaint(node, 'strokes', name, opacity);
    if (typeof weight === 'object') for (const [k, p] of Object.entries(SIDES)) node[p] = weight[k] || 0;
    else node.strokeWeight = weight;
    node.strokeAlign = align;
  }
  /** Copy stroke weights, per side when they differ (strokeWeight reads figma.mixed then). */
  function copyWeights(from, to) {
    if (from.strokeWeight === figma.mixed) for (const p of Object.values(SIDES)) to[p] = from[p];
    else to.strokeWeight = from.strokeWeight;
  }

  // ── geometry ──
  const CORNERS = ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'];
  function radius(node, name) {
    if (name === 'full') { node.cornerRadius = 9999; return; } // raw by design: list `rounded-full` in allowRaw
    for (const k of CORNERS) node.setBoundVariable(k, need(name));
  }
  /**
   * Fix ONE dimension of an auto-layout frame and leave the other as it was.
   * resize() flips BOTH sizing modes to FIXED, so a bare `c.resize(292, 56)`
   * freezes the height too — content then overflows silently and autoBind binds
   * the frozen height to whatever spacing step it happens to equal.
   */
  function fixSize(node, prop, px) {
    const horiz = node.layoutMode === 'HORIZONTAL';
    const modes = node.layoutMode && node.layoutMode !== 'NONE' ? { primary: node.primaryAxisSizingMode, counter: node.counterAxisSizingMode } : null;
    if (prop === 'width') node.resize(px, node.height); else node.resize(node.width, px);
    if (!modes) return node;
    // the axis we fixed is FIXED; the other axis keeps its previous mode
    const fixedIsPrimary = (prop === 'width') === horiz;
    if (fixedIsPrimary) { node.primaryAxisSizingMode = 'FIXED'; node.counterAxisSizingMode = modes.counter; }
    else { node.counterAxisSizingMode = 'FIXED'; node.primaryAxisSizingMode = modes.primary; }
    return node;
  }
  const fixWidth = (node, px) => fixSize(node, 'width', px);
  const fixHeight = (node, px) => fixSize(node, 'height', px);

  /** Bind one numeric field to the spacing step with exactly that value; returns false if off-scale. */
  function bindSpacing(node, prop, px) {
    // width/height are read-only on scene nodes — go through fixSize(), and only
    // when the size really changes.
    if (px != null && node[prop] !== px) {
      if (prop === 'width' || prop === 'height') fixSize(node, prop, px);
      else node[prop] = px;
    }
    const v = S.spacing[String(Math.round(node[prop] * 100) / 100)];
    if (!v) return false;
    node.setBoundVariable(prop, v);
    return true;
  }
  /** space(node, { p, px, py, pt, pr, pb, pl, gap, w, h }) — Tailwind-style, every value bound. */
  function space(node, o) {
    const set = { paddingTop: o.pt ?? o.py ?? o.p, paddingBottom: o.pb ?? o.py ?? o.p, paddingLeft: o.pl ?? o.px ?? o.p, paddingRight: o.pr ?? o.px ?? o.p, itemSpacing: o.gap, width: o.w, height: o.h };
    const off = [];
    for (const [prop, px] of Object.entries(set)) {
      if (px == null) continue;
      if (!bindSpacing(node, prop, px)) off.push(`${prop}=${px}`);
    }
    return off; // non-empty → off the scale: fix it, or allowRaw it
  }

  // ── nodes ──
  function al(dir = 'HORIZONTAL', props = {}) {
    const f = figma.createAutoLayout(dir, props);
    f.fills = [];
    f.clipsContent = false; // rule 5
    return f;
  }
  function comp(name, dir = 'HORIZONTAL', props) {
    const c = figma.createComponent();
    c.name = name;
    c.layoutMode = dir;
    c.primaryAxisSizingMode = 'AUTO';
    c.counterAxisSizingMode = 'AUTO';
    c.fills = [];
    c.clipsContent = false;
    if (props) c.set(props);
    return c;
  }
  async function text(chars, { size = 14, weight = 'Regular', family = 'Inter', color = S.defaults.text, opacity, style, lineHeight, name = 'label' } = {}) {
    const t = figma.createText();
    t.name = name;
    if (style) {
      const st = S.text[style];
      if (!st) throw new Error(`no text style ${style}`);
      await figma.loadFontAsync(st.fontName);
      await t.setTextStyleIdAsync(st.id);
    } else {
      t.fontName = { family, style: weight };
      t.fontSize = size;
      t.lineHeight = lineHeight ? { value: lineHeight, unit: 'PIXELS' } : { unit: 'AUTO' };
    }
    t.characters = chars;
    await setPaint(t, 'fills', color, opacity);
    return t;
  }
  /**
   * An icon instance, resized, recoloured through its single `Glyph` vector.
   * `opacity` goes on the INSTANCE layer (rule 2): the Glyph lives inside an
   * instance, where alphaPass never reaches, so a translucent bound paint there
   * would render at 100%.
   */
  async function icon(key, size = 16, color = S.defaults.icon, opacity) {
    const c = S.icons[key];
    if (!c) throw new Error(`no icon ${key} — pass iconPage to init()`);
    const i = c.createInstance();
    i.name = 'icon';
    i.resize(size, size);
    const g = i.findOne((n) => n.name === 'Glyph');
    if (g) {
      if (g.strokes.length) { await setPaint(g, 'strokes', color); g.strokeWeight = (2 * size) / 24; }
      if (g.fills.length) await setPaint(g, 'fills', color);
    }
    if (opacity != null && opacity !== 1) i.opacity = opacity;
    return i;
  }
  async function effect(node, name) {
    const st = S.effect[name];
    if (!st) throw new Error(`no effect style ${name}`);
    await node.setEffectStyleIdAsync(st.id);
  }
  /** Set an instance's component property by display name (Label, Show icon, Icon…). */
  function prop(instance, name, value) {
    const k = Object.keys(instance.componentProperties).find((x) => x.split('#')[0] === name);
    if (!k) throw new Error(`no property ${name}`);
    instance.setProperties({ [k]: value });
    return instance;
  }
  /** Add a component property to a set/component and wire every node with that layer name. */
  function wire(owner, label, type, defaultValue, layerName, field) {
    const key = owner.addComponentProperty(label, type, defaultValue);
    for (const n of owner.findAll((n) => n.name === layerName && !inInstance(n))) {
      n.componentPropertyReferences = { ...(n.componentPropertyReferences || {}), [field]: key };
    }
    return key;
  }
  const variantName = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ');

  // ── rule 2: translucency on the layer ──
  function inInstance(n) { for (let p = n.parent; p; p = p.parent) if (p.type === 'INSTANCE') return true; return false; }
  async function alphaPass(root) {
    const nodes = [root, ...(root.findAll ? root.findAll(() => true) : [])];
    const translucent = (p) => p && p.type === 'SOLID' && p.boundVariables && p.boundVariables.color && p.opacity != null && p.opacity < 0.999;
    let changed = 0;
    for (const n of nodes) {
      if (n.type === 'INSTANCE' || n.removed || inInstance(n)) continue;
      const fl = Array.isArray(n.fills) ? n.fills : [];
      const st = Array.isArray(n.strokes) ? n.strokes : [];
      if (!fl.some(translucent) && !st.some(translucent)) continue;
      const container = (n.type === 'FRAME' || n.type === 'COMPONENT') && 'appendChild' in n;
      if (!container) {
        const op = Math.min(...[...fl, ...st].filter(translucent).map((p) => p.opacity));
        if (op <= 0.001) { n.strokes = st.filter((p) => !translucent(p)); continue; }
        n.opacity = op;
        n.fills = fl.map((p) => (translucent(p) ? { ...p, opacity: 1 } : p));
        n.strokes = st.map((p) => (translucent(p) ? { ...p, opacity: 1 } : p));
        changed++;
        continue;
      }
      const layer = async (layerName, p, asStroke) => {
        const r = figma.createRectangle();
        r.name = layerName;
        n.insertChild(layerName === 'wash' ? 0 : n.children.filter((c) => c.name === 'wash').length, r);
        if (n.layoutMode && n.layoutMode !== 'NONE') r.layoutPositioning = 'ABSOLUTE';
        r.resize(Math.max(n.width, 0.01), Math.max(n.height, 0.01));
        r.x = 0; r.y = 0;
        r.constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' };
        const bv = n.boundVariables || {};
        for (const k of CORNERS) {
          if (bv[k]) r.setBoundVariable(k, await figma.variables.getVariableByIdAsync(bv[k].id));
          else r[k] = n[k] || 0;
        }
        const solid = { ...p, opacity: 1 };
        if (asStroke) { r.fills = []; r.strokes = [solid]; copyWeights(n, r); r.strokeAlign = n.strokeAlign; }
        else r.fills = [solid];
        r.opacity = p.opacity;
        r.locked = true;
      };
      // a surface that casts a shadow keeps an opaque fill, or the shadow falls from the content
      const casts = (n.effects || []).some((e) => e.type === 'DROP_SHADOW' && e.visible !== false);
      if (casts) n.fills = fl.map((p) => (translucent(p) ? { ...p, opacity: 1 } : p));
      else { for (const p of fl.filter(translucent)) await layer('wash', p, false); n.fills = fl.filter((p) => !translucent(p)); }
      for (const p of st.filter(translucent)) if (p.opacity > 0.001) await layer('hairline', p, true);
      n.strokes = st.filter((p) => !translucent(p));
      changed++;
    }
    return changed;
  }

  // ── rules 3 + 4: bind every on-scale padding / gap / fixed size ──
  const GAPS = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'itemSpacing', 'counterAxisSpacing'];
  const overridden = (n) => { const o = n.overrides.find((x) => x.id === n.id); return o ? o.overriddenFields : []; };
  function sizing(n, axis) { try { return axis === 'w' ? n.layoutSizingHorizontal : n.layoutSizingVertical; } catch { return 'FIXED'; } }
  function autoBind(root) {
    const off = new Set();
    let bound = 0;
    const tryBind = (n, prop) => {
      const val = n[prop];
      if (typeof val !== 'number' || val <= 0 || (n.boundVariables || {})[prop]) return;
      if (bindSpacing(n, prop)) bound++;
      else off.add(`${n.name}.${prop}=${val}`);
    };
    const walk = (n) => {
      const isInst = n.type === 'INSTANCE';
      const ov = isInst ? overridden(n) : null;
      if (isInst) { for (const p of GAPS) if (ov.includes(p)) tryBind(n, p); }
      else if (n.layoutMode && n.layoutMode !== 'NONE') for (const p of GAPS) tryBind(n, p);
      if (['FRAME', 'COMPONENT', 'INSTANCE', 'RECTANGLE', 'ELLIPSE'].includes(n.type) && !/^(wash|hairline)$/.test(n.name)) {
        let w, h;
        if (n.parent && n.parent.type === 'COMPONENT_SET') {
          if (n.layoutMode && n.layoutMode !== 'NONE') {
            const horiz = n.layoutMode === 'HORIZONTAL';
            w = (horiz ? n.primaryAxisSizingMode : n.counterAxisSizingMode) === 'FIXED';
            h = (horiz ? n.counterAxisSizingMode : n.primaryAxisSizingMode) === 'FIXED';
          }
        } else {
          w = sizing(n, 'w') === 'FIXED';
          h = sizing(n, 'h') === 'FIXED';
          if (isInst) { w = w && ov.includes('width'); h = h && ov.includes('height'); }
        }
        for (const [ok, p] of [[w, 'width'], [h, 'height']]) {
          if (ok && !(n.boundVariables || {})[p] && S.spacing[String(Math.round(n[p] * 100) / 100)]) { try { bindSpacing(n, p); bound++; } catch {} }
        }
      }
      if (isInst) return; // its insides belong to its own main component
      if ('children' in n) for (const c of n.children) walk(c);
    };
    for (const k of root.type === 'COMPONENT_SET' ? root.children : [root]) walk(k);
    return { bound, offScale: [...off] };
  }

  /** Lay a set's variants out on a grid: `colAxis` across, every other axis down. */
  function grid(cs, colAxis, gap = 16, pad = 32) {
    const parse = (n) => Object.fromEntries(n.name.split(', ').map((p) => p.split('=')));
    const kids = cs.children.map((c) => ({ c, p: parse(c) }));
    const cols = [...new Set(kids.map((k) => k.p[colAxis]))];
    const rowKey = (k) => Object.entries(k.p).filter(([a]) => a !== colAxis).map(([, x]) => x).join('|');
    const rows = [...new Set(kids.map(rowKey))];
    const colW = cols.map((cv) => Math.max(...kids.filter((k) => k.p[colAxis] === cv).map((k) => k.c.width)));
    const rowH = rows.map((rv) => Math.max(...kids.filter((k) => rowKey(k) === rv).map((k) => k.c.height)));
    const cx = [pad]; colW.forEach((w, i) => cx.push(cx[i] + w + gap));
    const ry = [pad]; rowH.forEach((h, i) => ry.push(ry[i] + h + gap));
    for (const k of kids) { k.c.x = cx[cols.indexOf(k.p[colAxis])]; k.c.y = ry[rows.indexOf(rowKey(k))]; }
    cs.resizeWithoutConstraints(cx[cx.length - 1] - gap + pad, ry[ry.length - 1] - gap + pad);
    return cs;
  }

  /** alphaPass → combine → name → describe → bind spacing → grid → stack below the page's last node. */
  async function finish(comps, name, description, colAxis, page) {
    for (const c of comps) await alphaPass(c);
    const set = comps.length > 1 || comps[0].name.includes('=') ? figma.combineAsVariants(comps, page) : comps[0];
    set.name = name;
    if (set.type === 'COMPONENT_SET') {
      grid(set, colAxis);
      // The set frame is documentation chrome, not a component, so a raw grey is
      // fine when the token shape has no background/border role.
      if (S.vars[S.chrome.fill]) await fill(set, S.chrome.fill); else set.fills = [{ type: 'SOLID', color: { r: 0.97, g: 0.97, b: 0.98 } }];
      if (S.vars[S.chrome.stroke]) await stroke(set, S.chrome.stroke); else { set.strokes = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.87 } }]; set.strokeWeight = 1; }
      set.dashPattern = [6, 4];
      set.cornerRadius = 12;
    } else if (set.parent !== page) page.appendChild(set);
    set.description = description.replace(/[<>"]/g, ''); // Figma escapes these on write
    const binding = autoBind(set);
    const others = page.children.filter((n) => n !== set);
    set.x = 0;
    set.y = others.length ? Math.max(...others.map((n) => n.y + n.height)) + 120 : 0;
    // Scene nodes reject expando properties (`set._binding = …` throws "no such
    // property"), so the binding report lives on the kit: kit.state.binding[set.id].
    S.binding = { ...(S.binding || {}), [set.id]: binding };
    return set;
  }

  /** Everything still raw inside a component: unbound paints, off-scale or unbound spacing. */
  function audit(root) {
    const rawPaint = new Set(), rawSpacing = new Set();
    const paints = (n, prop, label) => {
      const ps = n[prop];
      if (Array.isArray(ps)) for (const p of ps) {
        if (p.visible === false) continue;
        if (p.type === 'SOLID' && !(p.boundVariables || {}).color) rawPaint.add(`${label}.${prop}`);
        // a gradient is raw unless every stop is bound
        else if (p.type.startsWith('GRADIENT') && !(p.gradientStops || []).every((s) => (s.boundVariables || {}).color)) rawPaint.add(`${label}.${prop} (gradient)`);
      }
    };
    const walk = (n) => {
      const isInst = n.type === 'INSTANCE';
      const ov = isInst ? overridden(n) : null;
      if (n.layoutMode && n.layoutMode !== 'NONE') for (const p of GAPS) {
        if (isInst && !ov.includes(p)) continue;
        if (n[p] > 0 && !(n.boundVariables || {})[p]) rawSpacing.add(`${n.name}.${p}=${n[p]}`);
      }
      if (!isInst) for (const prop of ['fills', 'strokes']) paints(n, prop, n.name);
      if (isInst) {
        // An instance's insides belong to its main component — EXCEPT the paints
        // this instance overrides (an icon recoloured to a raw hue, say), which
        // live here and would otherwise never be audited anywhere.
        for (const o of n.overrides) {
          const fields = o.overriddenFields.filter((f) => f === 'fills' || f === 'strokes');
          if (!fields.length) continue;
          const sub = o.id === n.id ? n : n.findOne((x) => x.id === o.id);
          if (sub) for (const f of fields) paints(sub, f, `${n.name}/${sub.name}`);
        }
        return;
      }
      if ('children' in n) for (const c of n.children) walk(c);
    };
    for (const k of root.type === 'COMPONENT_SET' ? root.children : [root]) walk(k);
    return { name: root.name, id: root.id, rawPaint: [...rawPaint], rawSpacing: [...rawSpacing] };
  }

  return { init, paint, setPaint, fill, stroke, copyWeights, radius, bindSpacing, space, fixSize, fixWidth, fixHeight, al, comp, text, icon, effect, prop, wire, variantName, alphaPass, autoBind, grid, finish, audit, state: S };
})();
