# The Claude Code plugin and the programmatic API

## The Claude Code plugin

The plugin has two skills, invoked as `/figma-code-sync:<skill>` or picked up automatically:

- **`design-audit`** compares the live Library with your files through the Figma MCP. It covers the part REST can't see: **variable values in every mode**, **unbound raw values inside components**, and the inventory. It ends with `DRIFT: <mismatches> / <unbound> / <component changes>`. It also handles "push the token change to Figma", "pull token drift from Figma" and "refresh the snapshot".
- **`figma-workflow`** covers the three workflows:
  - **A (Figma → code):** implement a frame from Library instances, and stop to ask instead of guessing.
  - **B (code → Figma):** edit the Library component itself, never instances, and only **after** the code change is committed.
  - **C (tokens, either direction).**

  It also carries the definition of done and the Plugin API lessons from [Caveats](caveats.md#figma).

What Claude does vs what you do:

| Claude (via the Figma MCP) | You |
|---|---|
| Creates and updates variables, styles, components and screens | Reviews the result |
| Keeps the map, the `Code:` description line and the snapshot in step | **Publishes the Library** |
| Runs the audit and reports drift | Decides which side is right when they disagree |

#### How the Library is built (the kit)

`plugin/skills/figma-workflow/references/kit.js` is prepended to every script
Claude runs against your Library. It resolves everything **by name**
(`color/primary`, `spacing/3`, `Text/body`, `Icon/plus`), so it works in any
project whose variables were written from `design/tokens.json`. It enforces three rules, and names a fourth it can only ask you to keep. We learned each one the hard way:

| Rule | Why |
|---|---|
| Every padding, gap and fixed size on the spacing scale is bound to `spacing/*`. Off-scale values are reported, never rounded. | A raw number is invisible drift. Rounding a 13px to 12px would hide a real disagreement with the code, so it's surfaced instead. |
| A nested instance binds **only the fields it overrides**. | Binding an inherited value turns it into an override. The instance would stop following its main component, so the next change to the Button wouldn't reach the Buttons inside a ButtonGroup. |
| Translucency lives on the **layer** (node opacity, or a locked `wash` rectangle), not the paint. | Instances render variable-bound paint opacity at 100%, so a `bg-primary/10` wash turns solid the moment the component is used. |
| *(convention, not enforced by the kit)* Variant axes are the code's enumerations, exactly. No `State=Hover` axes, no prettified names. | Every variant in Figma must mean something in code; `check` catches a mismatch once the snapshot is refreshed. Interaction states live in the description. |

After each component, `kit.audit()` lists anything still raw. The expected
result is empty, or exactly the map entry's `allowRaw`.

#### Why is publishing manual?

Publishing a library pushes changes into every file that uses it, which is a
release. The Plugin API can't publish, and we wouldn't want it to. The snapshot
gate exists precisely because publishing is unreviewed; making it automatic
would remove the one human checkpoint.

## Using it from your own test runner

Some checks need knowledge only your codebase has. A React component roster lives
in JSX that only your bundler or Jest can evaluate. The programmatic API takes it
as data:

```js
const { check, tokens, loadConfig } = require('figma-code-sync');
const config = loadConfig(__dirname);

test('generated tokens are fresh', () => {
  expect(tokens.check(config).fresh).toBe(true);
});

test('map, code roster and Figma snapshot agree', () => {
  // { Button: { file: 'src/components/ui/button.jsx', props: { variant: BUTTON_VARIANTS, size: BUTTON_SIZES } }, … }
  const roster = buildRoster();             // from your component metadata
  const { errors } = check.run(config, { roster, iconKeys: Object.keys(ICONS) });
  expect(errors).toEqual([]);
});
```

This is how Tripeaz runs it: the roster comes from its `PRIMITIVES` registry and
per-component meta files, so `npm test` (and therefore its deploy gate) fails the
moment a component is added without a map entry.

---

*Part of [figma-code-sync](../README.md).*
