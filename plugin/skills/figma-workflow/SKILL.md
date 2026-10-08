---
name: figma-workflow
description: Run a figma-code-sync workflow — implement a Figma frame in code (Workflow A), reflect a code change into the Figma Library or Product file (Workflow B), or move a token change between code and Figma (Workflow C) — while keeping design/component-map.json, the component description line and the snapshot in step. Use whenever a project with figma-sync.config.js is asked to "implement this Figma link", "reflect this change in Figma", "put this screen in Figma", "add a component to the Library" or similar.
---

# Figma ↔ code workflows

The project's `design/WORKFLOW.md` is the contract: decisions, artifact owners
and the definition of done. Read it first; where it differs from this skill, it
wins. Load the Figma `figma-use` skill before any `use_figma` call.

Principles that hold in every project:
- **Name identity.** A Figma component is named exactly what its code symbol is named. `design/component-map.json` records what a name can't: variant value → prop value, properties, slots, values allowed to stay raw (`allowRaw`), and what is still owed (`pending`).
- **One Library, one Product file.** Components, variables and styles live only in the published Library. The Product file holds screens built from Library **instances**: no local components, nothing detached.
- **Every value is bound.** Fills, strokes, text colours and radii are bound to variables. A raw value is a bug unless the map's `allowRaw` names it.
- **The description line.** Every Library component's description starts `Code: <Symbol> — <path>`. Avoid `<`, `>` and `"`, because Figma escapes them on write.

## Building the Library (first time, or a new component)

Use `references/kit.js`. Read it, then prepend it to every `use_figma` script that creates or edits Library components. Build in this order, one coherent step per call:

1. **Tokens → variables** (the `design-audit` skill, "Push the token change"). Write every group in `design/tokens.json`:
   - `color/*`: COLOR variables, one mode per token mode.
   - `radius/*`: FLOAT variables.
   - `spacing/*`: FLOAT variables, scopes `GAP` + `WIDTH_HEIGHT`.
   - `font/*`: STRING variables.

   Set each variable's code syntax from `$extensions.web.var`. **If tokens.json has no `spacing` group, stop and say so.** The web adapter emits one only when the config sets `tokens.options.spacing` and the stylesheet declares `--spacing`. Components can't be bound without it.
2. **Styles.** Make one text style per type register and one effect style per elevation step, named after the code (`Text/body`, `Elevation/md`).
3. **Icons.** Make one `Icon/<key>` component per registry key, each holding a single vector named `Glyph`. Bulk-import the SVG files with `upload_assets` (multipart, filename = key), then convert them into components.
4. **A Foundations page.**
   - Show the colour roles in two columns, each pinned to its mode with `setExplicitVariableModeForCollection`, so the Dark column shows real Dark values.
   - Show the spacing scale as bars whose width is bound to each step.
   - Add radii, type specimens set in each text style, and elevation cards.
   - Label everything with its code syntax.
5. **Components**, atoms before composites. First `await kit.init({ fonts, iconPage: '<Icons page id>' })`; pass `defaults` / `chrome` when the token roles aren't shadcn-shaped (`color/foreground`, `color/background`, `color/border`). Then `kit.comp()` → `kit.space()` / `kit.fill()` / `kit.radius()` / `kit.text()` / `kit.icon()` → `kit.finish()`.
   - `finish()` runs the alpha pass and `autoBind()`, then returns the set. The binding report (bound count, off-scale values) is at `kit.state.binding[set.id]`.
   - Composites use **instances** of built components, never copies.
6. **Verify each component** before moving on:
   - `kit.audit(set)` must report no raw paint, and spacing only where the map's `allowRaw` says so.
   - Take one screenshot and look at it.

**Binding rules the kit enforces (don't work around them):**
- Every padding, gap and fixed size on the spacing scale is bound to `spacing/*`. A value off the scale is a bug, or an `allowRaw` entry with its reason (for example an arbitrary `p-[3px]` in the code).
- A nested instance binds only the fields it **overrides**. Binding an inherited value creates an override that silently stops following the main component.
- Translucent colours are put on the layer (the alpha pass), because instances render variable-bound paint opacity at 100%.

**A rule the kit can't enforce, so you must:** variant axes and values are the code's own enumerations, exactly. No extra State axes, no prettified names. `figma-code-sync check` catches a mismatch after the snapshot is refreshed, not while you build.

## Workflow A: Figma → code ("Implement [Figma link]")

1. Read the frame: `get_metadata` gives the instances and variant values; `get_design_context` gives descriptions, text and bound variables.
2. Resolve every instance to code through its name and the map. Compose from existing components only.
3. **Stop and ask** instead of guessing when:
   - an instance has no code symbol and no map entry;
   - a value is raw and differs from its token (implement with the token and flag it);
   - a plain frame looks like it should be an instance.
4. Verify the result against `get_screenshot` next to the running app.
5. If the change builds a component whose map entry carries `code.pending`, drop `code.pending` in the same change.

## Workflow B: code → Figma ("Reflect the X change in Figma")

**Only after the code change is committed.** While code is still moving, the
map entry carries `figma: null` + `pending: "<what Figma owes>"`. The check
reports it on every run, and `figma-code-sync snapshot` points it at the
component by exact name once it is published.

- **B1, a component changed:**
  1. Edit the **Library component** itself: a variant, a property, a binding. Never edit instances.
  2. Update the map entry, the `Code:` line and the snapshot in the same change.
  3. The user publishes.
- **B2, a new screen:**
  1. Place **instances of published Library components** in the Product file and set their properties.
  2. Never create a component there, detach one, or place a `nonApi` variant.
  3. If a view has no counterpart, propose a Library component instead (that is B1).
- **A new component:** variant axes are the code's enumerations, title-cased (`variant` → `Variant`), and their values are the code's exact strings. Add the map entry with `figma: null` + `pending` first.

## Workflow C: tokens

- **From code:**
  1. Edit the token source. That is `design/tokens.json` in emit mode, or the stylesheet in extract mode (see `figma-sync.config.js`).
  2. Run `npx figma-code-sync tokens`.
  3. Push to Figma with the `design-audit` skill's "Push" section.
  4. The user publishes.
- **From Figma:** run the `design-audit` skill, then write the diff back into the token source and regenerate.

## Definition of done (any component change)

- [ ] The Figma name equals the code symbol, or the map records the pairing.
- [ ] Every value is bound, or listed in `allowRaw`.
- [ ] The `Code:` description line is current.
- [ ] The map entry is current: axes, properties, slots, pending.
- [ ] The snapshot has been refreshed (`npx figma-code-sync snapshot`).
- [ ] `npx figma-code-sync check` passes.
- [ ] The Library is published and the Product file has accepted the update.

## Plugin API lessons that cost real time

- **Assigning a variable-bound paint resets its `opacity` to 1.** Bind, assign, then reassign a copy with the opacity: `node.fills = [bound]; node.fills = [{ ...node.fills[0], opacity: 0.1 }]`.
- **Instances can still drop paint opacity on bound paints**, so a `bg-primary/10` wash renders solid in every instance. Put translucency on the layer instead:
  - a text or shape node gets node `opacity`;
  - a frame gets a locked, absolutely positioned `wash` rectangle at full size, carrying the bound fill and the opacity.
  - Keep surfaces that cast a shadow opaque, or the shadow appears to fall from the content.
- **`createFrame()` clips by default.** Set `clipsContent = false` on frames that hold components, or shadows get shaved.
- **Icons:** make one component per icon (`Icon/<name>`), each holding a single vector named `Glyph`. Colour overrides survive an instance swap only when layer names match. `upload_assets` imports SVG files as editable vectors, so bulk icons never have to pass through a script.
- **A component set is a definition, not a switcher.** Editing a variant's value on the master renames it, and duplicate variant names break publishing.
- **`get_metadata` without a node ID lists only the first page.** Query by ID.
