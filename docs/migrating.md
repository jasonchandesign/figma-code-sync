# Migrating from the original Python scripts

If your repo runs `gen_theme.py`, `check_design_sync.py` and `fetch_figma_snapshot.py` (Math Sheets Unlimited / Seesay Lingo style):

1. Run `npm i -D github:jasonchandesign/figma-code-sync#v0.1.0`, then `npx figma-code-sync init --adapter swift`. It keeps your existing `design/` files.
2. In `figma-sync.config.js`:
   - set `tokens.out` to your `Theme+Generated.swift` path;
   - set `tokens.options = { header: 'scripts/gen_theme.py', regenerate: 'python3 scripts/gen_theme.py' }` if you want the banner byte-identical during the switch;
   - set `usage.roots` to your `UI/` directory.
3. `npx figma-code-sync tokens --check` should pass with no diff.
4. `npx figma-code-sync check` covers the map and snapshot checks. **It doesn't port these:**
   - the UI lint (palette names, `.white`, `Color(hex:)`, raw fonts or SF Symbols in views);
   - the Figma-owned icon glyph pipeline (`fetch_figma_icons.py` / `gen_glyphs.py`);
   - the "metric token referenced nowhere" warning.

   Keep those scripts for now if you rely on them.
5. Run one plain `npx figma-code-sync snapshot` to rewrite fingerprints in this format (see [Caveats](caveats.md#this-package)).
6. Point your hooks and CI at the new commands, then delete the old scripts.

---

*Part of [figma-code-sync](../README.md).*
