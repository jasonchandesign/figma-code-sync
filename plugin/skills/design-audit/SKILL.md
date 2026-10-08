---
name: design-audit
description: Compare a project's live Figma Library against its figma-code-sync files (design/tokens.json, design/component-map.json, design/figma-components.json) — variable values per mode, unbound raw values inside components, and component/axis changes — and report drift. Use before publishing the Library, after any Figma session, or when asked to "audit Figma drift", "pull token drift from Figma", "push the token change to Figma" or "refresh the snapshot". Requires the project to have a figma-sync.config.js.
---

# Design drift audit

The project's contract is `design/WORKFLOW.md`; read it first. Its config is
`figma-sync.config.js`, and the Library and Product file keys are in
`design/figma-components.json` (`fileKey`, `productFileKey`).

**Start with REST** when `FIGMA_TOKEN` or `~/.figma-token` is available. Run
`npx figma-code-sync snapshot --check`. In seconds, with no plugin session, it
reports what has **moved** since the snapshot: components added, removed or
changed, and for each change the axis, property, padding, gap, stroke or
unbound-paint difference. The inventory itself is `design/figma-components.json`
(a plain `snapshot` refreshes it).

REST cannot read a **variable's value**: the Variables REST API is
Enterprise-only. Step 2 is the part only this procedure can do.

Write nothing unless asked. Where an edit lands depends on the truth mode in
`figma-sync.config.js`:
- **emit** (`tokens.source` is `design/tokens.json`, e.g. the `swift` adapter): edit tokens.json, then run `npx figma-code-sync tokens`.
- **extract** (`tokens.source` is a stylesheet, e.g. `css-tailwind4`): edit the **source stylesheet**, then run `npx figma-code-sync tokens`. Never hand-edit the generated tokens.json.

Use the Figma MCP. Load the `figma-use` skill before any `use_figma` call;
read-only scripts need it too. Read nodes by ID with `figma.getNodeByIdAsync`.

## 1. Component inventory

Make one `use_figma` call on the Library. For every component set and
standalone component, list:
- `name`, `key`, `id` and page;
- variant axes: `componentPropertyDefinitions` of type `VARIANT`, in canvas order;
- non-variant properties: the name without its `#id` suffix, and the type.

Never read `componentPropertyDefinitions` from a variant; use its set. Diff
against the snapshot and classify each change as **added**, **removed**,
**renamed** (same `nodeId`, new name) or **axis-changed**.

## 2. Variables vs tokens

Make one `use_figma` call:
- `getLocalVariableCollectionsAsync()` and `getLocalVariablesAsync()`;
- `getLocalTextStylesAsync()` and `getLocalEffectStylesAsync()`.

Resolve each variable in **every** mode.

Map Figma names to token paths. The default is the slash path (`color/primary`
→ `color.primary`). A token's `$extensions.figma.name` (or `$extensions.figma`
as a string) overrides the default. Mode values live in `$value`, the first
mode, and `$extensions.modes.<mode>` for the rest.

Compare:
- **colour:** lowercase hex. `#rrggbb` equals `#rrggbbff`. Alpha is compared as 2 hex digits. Allow ±1 per channel when the source is oklch, because the conversion rounds.
- **number** (radius, spacing): `abs(a − b) ≤ 0.01`. Spacing steps are named `spacing/<step>`, with half steps as `0-5`, `1-5`, …
- **text style:** family, style, size, line height.
- **effect:** per shadow colour+alpha, x, y, blur, spread.
- **code syntax:** each variable's code syntax matches `$extensions.web.var` / `$extensions.swift.name`.

Status per token:
- `ok`
- `mismatch`: report both values, per mode
- `missing-in-figma`
- `missing-in-tokens`: ask whether it is a real product usage

## 3. Unbound raw values inside components

For each component set, walk every descendant that is not inside an `INSTANCE`.
Flag:
- a visible `SOLID` fill or stroke with no `boundVariables.color`;
- a corner radius that is not bound;
- a padding, gap or fixed width/height that is **on the spacing scale but not bound** to `spacing/*`. On a nested instance, only the fields it overrides count;
- a `TEXT` node with no `textStyleId`, unless the project's WORKFLOW says text is styled per-node.

For each hit, report the component, layer path, property, value and nearest
token. Mark it `allowed` when the component's map entry lists it in
`allowRaw`; otherwise mark it `unbound`.

## 4. Script

Run `npx figma-code-sync check` (or the project's wrapper script) and paste the output.

## Report

Write four tables (Components · Variables · Raw values · Script), then:

```
DRIFT: <n mismatches> / <m unbound> / <k component changes>
```

Zero across the board is the expected state before a publish. Fix each item on
the side that is wrong: the token source wins on values, and the map wins on
names.

## Push the token change to Figma (only when asked)

Read the generated or hand-edited `design/tokens.json`.
- Create or update one collection per the project's WORKFLOW, with one mode per entry in `$extensions["figma-code-sync"].modes` (or a single mode).
- COLOR variables per colour token.
- FLOAT variables per dimension, in px.
- STRING variables per font family, using `$extensions.figma.family` when present.
- Set code syntax from the token's `$extensions`.
- Give every variable explicit scopes (never `ALL_SCOPES`).
- Never delete a variable a component is bound to without asking.

Report the changes, then remind the user to publish.

## Refresh the snapshot (only when asked)

Prefer `npx figma-code-sync snapshot`. Without a token, rewrite the snapshot
from step 1's data, keeping `fileKey`, `productFileKey`, `pages` and
`productScreens`, and set `capturedAt`. Names are the contract; node IDs change
on re-publish.
