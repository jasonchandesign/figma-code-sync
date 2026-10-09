# Adapters

| Adapter | Mode | Reads | Writes |
|---|---|---|---|
| `css-tailwind4` | extract | a Tailwind v4 / shadcn stylesheet | `design/tokens.json` |
| `swift` | emit | `design/tokens.json` | a SwiftUI theme file |

## `css-tailwind4`

- **What becomes a token:** the stylesheet's own `@theme` map decides, so there's no list to maintain.
  - `--color-<role>: var(--<role>)` → `color.<role>`, one value per mode
  - `--radius-<step>: calc(var(--radius) * k)` or `var(--radius)` → `radius.<step>` in px
  - `--font-<name>: '<Family>', …` → `font.<name>`
- **Modes:** custom-property blocks are resolved per mode **in source order**, so a later brand-override block wins exactly as it does in the browser. Example: `light: [':root', ':root, .dark']`, `dark: ['.dark', ':root, .dark']`.
- **Aliases:** `--a: var(--b)` chains are followed within a mode.
- **Colours:** oklch, hex (3/4/6/8) and rgb()/rgba() → `#rrggbb[aa]`. Out-of-gamut values are clamped, as the browser does.
- **Spacing** (opt-in, `options.spacing.steps`): declare Tailwind v4's own base in your stylesheet, `@theme { --spacing: 0.25rem; }`. That's its default, so nothing on screen changes. Each step N then becomes:
  - `spacing.N` = N × base px;
  - code syntax `calc(var(--spacing) * N)`, which is exactly what `p-N`, `gap-N` and `size-N` compile to;
  - Figma name `spacing/N`, with half steps written `0-5`, `1-5`, … because neither DTCG nor Figma allows `.` in a token name.

  Asking for spacing without declaring `--spacing` is an error, not a guess.
- **Each token records** its CSS variable (`$extensions.web.var`) for Figma code syntax, its original value per mode (`$extensions.source`), and `$extensions.figma.name` / `.family`.

| Option | Default | |
|---|---|---|
| `modes` | `light: [':root', ':root, .dark', ':root:not(.dark)']`, `dark: ['.dark', ':root, .dark']` | which selector blocks feed which mode |
| `remPx` | 16 | px per rem |
| `figmaFonts` | `{}` | CSS family → Figma family, e.g. `{ 'Inter Variable': 'Inter' }` |
| `spacing` | none | `{ steps: [0.5, 1, 1.5, 2, …, 24] }`: publish the spacing scale (requires `--spacing` in an `@theme` block) |

## `swift`

A line-for-line port of the generator the two Swift apps ran. On a real
production token file it produces **byte-identical** output.

| Token group | Generated Swift |
|---|---|
| `palette.<group>.<x>` | `extension Theme { static let navy900 = Color(hex: 0x1E2552) }` |
| `color.<group>.<x>` (exactly 3 levels) | `extension Theme { static let textPrimary = navy900 }` (aliases keep their name) |
| `spacing.*`, `radius.*` | `Layout` / `Radius` / `Theme` per `$extensions.swift.name` (required) |
| `type.*` (`$type: typography`) | `AppFont.<name> = TextStyle(family:weight:size:lineHeight:)` |
| `effect.*` (`$type: shadow`) | `Elevation.<name> = ShadowStyle(…)` |

`$description` becomes `///` doc comments, alongside `$extensions.swift.doc`.
Colours may carry alpha (`#RRGGBBAA` → `Color(hex:opacity:)`). Key order follows
the file, including integer-like keys such as `"900"`, which a plain
`JSON.parse` would reorder. Options: `header`, `source` and `regenerate` set the
banner text. The generated code expects hand-written shells (`Theme`, `Layout`,
`Radius`, `AppFont`, `TextStyle`, `ShadowStyle`, `Color(hex:opacity:)`) in your
app.

## Writing your own

An adapter is a module that exports one of these, and `tokens.adapter: './my-adapter.js'` loads it:

```js
// extract mode: platform → tokens
exports.read = ({ source, options }) => ({ tree, modes, errors });  // tree = { color: {…}, radius: {…}, … }

// emit mode: tokens → platform
exports.render = (tokens, { sha256, options }) => '…file contents…';
exports.parse = (text) => tokens;  // optional; use it if key order matters
```

---

*Part of [figma-code-sync](../README.md).*
