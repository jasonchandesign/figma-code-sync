'use strict';
/**
 * The token step. Two truth modes, chosen by the adapter:
 *
 *   extract  the platform file is the truth (a theme stylesheet); tokens.json
 *            is GENERATED from it and is what Figma variables are written from.
 *   emit     tokens.json is the truth (hand-edited); the adapter renders the
 *            platform file from it (Swift, CSS, …).
 *
 * Either way the generated file embeds the sha256 of its source, so `--check`
 * is a byte comparison: regenerate in memory, compare to disk.
 */

const fs = require('fs');
const path = require('path');
const { sha256, normalizeEol, stringify, rel } = require('./util');

function loadAdapter(name, root) {
  if (name.startsWith('.') || path.isAbsolute(name)) return require(path.resolve(root, name));
  return require(path.join(__dirname, '..', 'adapters', name));
}

/** Expected bytes of the generated file, and where it goes. */
function build(config) {
  const t = config.tokens;
  const adapter = loadAdapter(t.adapter, config.root);
  const source = path.resolve(config.root, t.source);
  const out = path.resolve(config.root, t.out);
  const sourceText = normalizeEol(fs.readFileSync(source, 'utf8'));

  if (typeof adapter.read === 'function') {
    const { tree, modes, errors } = adapter.read({ source, options: t.options || {} });
    const doc = {
      $description: `GENERATED from ${rel(config.root, source)} by figma-code-sync — do not edit. Edit the source, then run the tokens step.`,
      $extensions: {
        'figma-code-sync': { source: rel(config.root, source), sha256: sha256(sourceText), modes },
      },
      ...tree,
    };
    return { out, text: stringify(doc), errors: errors || [] };
  }
  if (typeof adapter.render === 'function') {
    const text = adapter.render(adapter.parse ? adapter.parse(sourceText) : JSON.parse(sourceText), { sha256: sha256(sourceText), options: t.options || {} });
    return { out, text, errors: [] };
  }
  throw new Error(`token adapter ${t.adapter} exports neither read() nor render()`);
}

function write(config) {
  const { out, text, errors } = build(config);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text, 'utf8');
  return { out, errors };
}

/** { fresh, out, errors } — fresh is false when the committed file differs. */
function check(config) {
  const { out, text, errors } = build(config);
  const current = fs.existsSync(out) ? normalizeEol(fs.readFileSync(out, 'utf8')) : '';
  return { fresh: current === text, out, errors };
}

module.exports = { build, write, check, loadAdapter };
