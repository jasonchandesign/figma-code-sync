# Concepts

## Truth modes

There is exactly one place a token value can be authored. Which place depends on
your platform's habits:

- **Emit** (`adapter: 'swift'`): you edit `design/tokens.json`, and the platform file is generated from it. Use this when nothing else owns your tokens; native apps usually work this way.
- **Extract** (`adapter: 'css-tailwind4'`): you edit your stylesheet, and `design/tokens.json` is generated from it. Use this when a tool already owns the stylesheet (shadcn's `apply --only theme` rewrites `:root`/`.dark`). Making tokens.json canonical there would give you two sources of truth, which is exactly the failure this package exists to prevent.

In both modes, `design/tokens.json` is what Figma's variables are written from,
and the generated file carries the sha256 of its source.

## What becomes a Figma variable

| Token group | Figma collection | Bound to, inside components |
|---|---|---|
| `color.*` (one value per mode) | `Theme`, with a mode per theme (Light, Dark) | every fill, stroke and text colour |
| `radius.*` | `Shape` | corner radii |
| `spacing.*` | `Spacing` | **every padding, gap and fixed size on the scale** |
| `font.*` | `Typography` | font family (via text styles) |

Spacing is the group people skip, and it's the one that drifts most: a designer
nudges a padding to 13px and nothing notices. With the scale published as
variables, a raw 13px inside a component is a finding, either a bug or an
`allowRaw` entry with a reason.

## Name identity

A Figma component is named **exactly** what its code symbol is named: `Button`,
`IconButton`, `DatePicker`. There's no "Button / Primary / Large" naming scheme
to translate. When the names have to differ, the map records it
(`code.export`). Variant axes are the code's enumerations, title-cased
(`variant` → `Variant`). Their values are the code's **exact strings**
(`destructive-ghost`, `icon-sm`), not prettified labels.

*Why:* every translation layer between design and code is a place to drift. If
the Figma variant is called `destructive-ghost`, an engineer reading a frame
knows the prop value without opening anything. The cost is that designers see
code-style names in the properties panel. We think that's the right trade.

## The component map

`design/component-map.json` is the reviewable contract for everything a name
can't express: variant value → prop value, Figma properties → code props,
slots, values allowed to stay raw (`allowRaw`), and anything still owed
(`pending`). See the [reference](reference.md#component-map-reference).

## The snapshot and its fingerprint

`design/figma-components.json` is the repo's **belief** about the published
Library: names, keys, axes, properties, timestamps, and a `shape` for each
component:

- `pad`, `gap`: the component's own layout, which is what a consumer's spacing compensates for. A component **set** carries one such record per **variant** (`shape.variants["Variant=outline, Size=sm"]`), so a re-padded variant is named, and a brand-new variant is additive.
- `strokes`: alignment/weight per stroked layer. A centred stroke sits half outside the frame, which matters and is invisible everywhere else.
- `unbound`: the count of visible fills and strokes with no variable behind them.
- `hash`: a digest of everything else (sizes, radii, effects, nesting), so a change the fields above don't name still trips the gate.

## Pending debt

When one side is ahead of the other, the map says so instead of pretending:

- `"figma": null, "pending": "what Figma owes"`: the code exists and the Library doesn't have it yet.
- `"code": { …, "pending": "what code owes" }`: the Library has it and code hasn't built it yet.

`check` reports every debt as a **warning on every run**. A refresh pays off a
`figma: null` debt automatically, and only by **exact name match**.

## Waivers

A blocking divergence can be accepted on the record with a line in the commit
message:

```
Design-drift: Button, Badge — re-padded to the 4px grid; code already matches
```

---

*Part of [figma-code-sync](../README.md).*
