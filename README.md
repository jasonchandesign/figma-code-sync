# figma-code-sync

**Keep a Figma library and a codebase one design, and find out when they stop being one.**

Your UI exists twice: once as code, and once as a component library in Figma.
Left alone, the two drift apart quietly. Someone changes a padding in Figma, adds
a variant in code, or tweaks a colour on one side only. Nobody notices until a
screen looks wrong in review, or worse, in production. Every handoff tool tries
to make the two sides *similar*. This one makes their differences **checkable**,
and refuses to let them pass unnoticed.

figma-code-sync gives you:

- **One source of truth for tokens**, with the other side generated from it and a freshness check that fails when someone edits the wrong file.
- **A component map**: an explicit, reviewable record of how every Figma component, variant and property maps onto code.
- **A snapshot of your published Figma Library**, read over the REST API. Each component carries a structural fingerprint covering padding, gap, strokes and unbound paints.
- **Gates** that compare all three and say exactly what moved. They block only when a change can actually break something your code calls.
- **A Claude Code plugin** that does the Figma-side work through the Figma MCP: building and updating the Library, auditing variable values, and implementing frames in code. It ships a **build kit** so the Library comes out wired the same way in every project:
  - colour, radius, **spacing** and font variables, written from your tokens;
  - every component's padding, gaps and control sizes bound to the spacing scale;
  - translucent fills that survive in instances;
  - a Foundations page showing all of it, in both modes.

It has no dependencies and needs Node 18+. It works on a Figma **Professional** plan, with no Code
Connect and no Enterprise APIs required.

> **Status: 0.1.** The system has run in three production projects: two SwiftUI apps (Math Sheets Unlimited, Seesay Lingo) and a React + Tailwind v4 + shadcn/ui web app (Tripeaz). This package extracts it. The code is tested; the packaging is new. Read [Caveats](#caveats-and-known-limitations) before relying on it.

---

## Contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Commands](#commands)
- [The gates: what they reject, and why](#the-gates-what-they-reject-and-why)
- [Configuration reference](#configuration-reference)
- [Component map reference](#component-map-reference)
- [Snapshot reference](#snapshot-reference)
- [The Claude Code plugin](#the-claude-code-plugin)
- [Using it from your own test runner](#using-it-from-your-own-test-runner)
- [Adapters](#adapters)
- [Caveats and known limitations](#caveats-and-known-limitations)
- [Migrating from the original Python scripts](#migrating-from-the-original-python-scripts)
- [FAQ](#faq)

---

## Why this exists

Design and code drift in a handful of predictable ways. Each one is a gate here:

| Drift | What usually happens | What this does |
|---|---|---|
| A token changes on one side | Light mode is fixed in Figma, and nobody updates the CSS | One side is generated from the other. Editing the generated side fails `tokens --check`. |
| A designer re-pads a component | Code keeps the old padding forever | The snapshot fingerprint records padding and gap per component, and `snapshot --check` names the change. |
| Code grows a variant | Figma never learns `destructive-ghost` exists | Given your component roster, `check` fails until the map, and so the Library, accounts for it. |
| Figma grows a variant | Engineers implement a variant code doesn't support | `check` fails on an unmapped variant value. |
| A component is renamed or deleted in Figma | Screens silently lose the component they referenced | The rename reads as a removal plus an addition, and the removal **blocks** if code calls it. |
| A raw hex sneaks into a Figma component | Dark mode breaks for that one component | The fingerprint counts unbound paints, and the audit names each one. |
| "We'll add it to Figma later" | Never | A `pending` debt is reported on every run until it's paid. |

The approach is the result of getting this wrong repeatedly. The reasoning
behind each gate is spelled out [below](#the-gates-what-they-reject-and-why),
because a gate you don't understand is a gate you'll bypass.

## How it works

```
                 ┌──────────────── token truth ─────────────────┐
  emit mode:     design/tokens.json ──generate──▶ Theme+Generated.swift
  extract mode:  src/index.css ──────generate──▶ design/tokens.json
                                                     │
                                       Claude (Figma MCP) writes
                                                     ▼
                                   Figma Library: variables + styles
                                   Figma Library: components ◀── name identity ──▶ code components
                                                     │                                    ▲
                                       REST (published only)          design/component-map.json
                                                     ▼                                    │
                                   design/figma-components.json ───── check ──────────────┘
                                   (snapshot + per-component fingerprint)
```

There are three files under `design/`, plus your config:

| File | What it is | Who writes it |
|---|---|---|
| `design/tokens.json` | DTCG-style tokens: the truth (emit mode) or generated (extract mode) | you, or `figma-code-sync tokens` |
| `design/component-map.json` | Figma ↔ code pairings for every component | you, or Claude following the `figma-workflow` skill |
| `design/figma-components.json` | What the **published** Library looks like, as of the last refresh | `figma-code-sync snapshot` |
| `figma-sync.config.js` | Where your token source, components and call sites live | you, once |

## Quick start

### Prerequisites

- Node 18 or later, and git.
- A Figma Professional (or higher) plan. You need it for variable modes and team libraries.
- [Claude Code](https://claude.com/claude-code) with the [Figma MCP server](https://help.figma.com/hc/en-us/articles/32132100833559) connected, if you want Claude to build and update the Library. The CLI works without it.
- A Figma **personal access token** with `file_content:read` and `library_content:read`, for the snapshot commands. Store it in `~/.figma-token` locally (never in the repo) and as the `FIGMA_TOKEN` secret in CI.

### Web: Tailwind v4 / shadcn, stylesheet is the truth

```sh
npm i -D github:jasonchandesign/figma-code-sync#v0.1.0   # the package isn't on npm; install from GitHub, pinned
npx figma-code-sync init                             # guided: detects the stylesheet, asks for the token and the Library, does the rest
```

`init` walks nine steps and prints each one: detect the adapter → scaffold → token → Library key (verified against the API) → generate tokens → snapshot the published Library → seed the map (design-first) → hooks → status. It is idempotent, so re-run it to resume; it never overwrites a file you edited. Add Tailwind's spacing base to the stylesheet when it asks (`@theme { --spacing: 0.25rem; }`, its default, so nothing changes on screen).

### SwiftUI: `design/tokens.json` is the truth

```sh
npm i -D github:jasonchandesign/figma-code-sync#v0.1.0   # fine in a non-Node repo: it adds package.json + node_modules (gitignore the latter)
npx figma-code-sync init --adapter swift
# then set tokens.out in figma-sync.config.js to your app's Theme+Generated.swift and run `npx figma-code-sync tokens`
```

To try it without installing anything, `npx github:jasonchandesign/figma-code-sync#v0.1.0 <command>` runs any command one-off. The git hooks, though, only look for a local install, so they stay silent until you add the devDependency.

### Non-interactive, and for AI agents

Every prompt has a flag, so `init` runs unattended in CI or from an agent:

```sh
npx figma-code-sync init --yes --library https://www.figma.com/design/<key>/Lib --seed
npx figma-code-sync status --json      # { state, next, errors: [{where, message}], … }
```

`status` classifies the project as `code-first`, `unseeded`, `design-first`, `in-step`, `diverged` or `in-sync`, and says what to do next; `--json` makes that machine-readable, and the exit code is 1 when diverged. The full agent procedure, with a check for every step, is in [`AGENTS.md`](AGENTS.md) (the Claude Code plugin ships it as the `setup` skill; [`llms.txt`](llms.txt) indexes the docs for other tools).

### Then, in Claude Code

```
/plugin marketplace add jasonchandesign/figma-code-sync
/plugin install figma-code-sync@figma-code-sync
```

Then ask Claude to "build the Figma Library from design/tokens.json and the
component map". Claude follows `/figma-code-sync:figma-workflow`. When the
Library looks right:

1. **Publish it in Figma.** That stays a human click; see [why](#why-is-publishing-manual).
2. Put the Library's file key in `design/figma-components.json` → `fileKey`.
3. Run `npx figma-code-sync snapshot`. Every map entry waiting as `figma: null` is now paired by name automatically.
4. Run `npx figma-code-sync check`. It should report zero errors.

> **Why a devDependency, pinned:** the hooks run `node_modules/.bin/figma-code-sync` and never call the npm registry (the package isn't there, so an `npx` lookup would 404 and block every commit). The CI template uses `npx --yes github:…#v0.1.0`, pinned to a tag so it doesn't fetch `main` on every run.

`init` creates these files and never overwrites one that exists (`--force` overrides):

```
figma-sync.config.js
design/component-map.json          empty, with an `$example` entry to copy
design/figma-components.json       empty snapshot: set fileKey after the first publish
design/WORKFLOW.md                 your contract: edit it to record your decisions
design/tokens.json                 (swift only) a starter token file
scripts/githooks/pre-commit        runs `check` when design files are staged
scripts/githooks/commit-msg        runs `snapshot --check --soft` (warns, never blocks)
.github/workflows/design-sync.yml  `check` + `snapshot --check --block` on push and PR
```

---

## Concepts

### Truth modes

There is exactly one place a token value can be authored. Which place depends on
your platform's habits:

- **Emit** (`adapter: 'swift'`): you edit `design/tokens.json`, and the platform file is generated from it. Use this when nothing else owns your tokens; native apps usually work this way.
- **Extract** (`adapter: 'css-tailwind4'`): you edit your stylesheet, and `design/tokens.json` is generated from it. Use this when a tool already owns the stylesheet (shadcn's `apply --only theme` rewrites `:root`/`.dark`). Making tokens.json canonical there would give you two sources of truth, which is exactly the failure this package exists to prevent.

In both modes, `design/tokens.json` is what Figma's variables are written from,
and the generated file carries the sha256 of its source.

### What becomes a Figma variable

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

### Name identity

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

### The component map

`design/component-map.json` is the reviewable contract for everything a name
can't express: variant value → prop value, Figma properties → code props,
slots, values allowed to stay raw (`allowRaw`), and anything still owed
(`pending`). See the [reference](#component-map-reference).

### The snapshot and its fingerprint

`design/figma-components.json` is the repo's **belief** about the published
Library: names, keys, axes, properties, timestamps, and a `shape` for each
component:

- `pad`, `gap`: the component's own layout, which is what a consumer's spacing compensates for. A component **set** carries one such record per **variant** (`shape.variants["Variant=outline, Size=sm"]`), so a re-padded variant is named, and a brand-new variant is additive.
- `strokes`: alignment/weight per stroked layer. A centred stroke sits half outside the frame, which matters and is invisible everywhere else.
- `unbound`: the count of visible fills and strokes with no variable behind them.
- `hash`: a digest of everything else (sizes, radii, effects, nesting), so a change the fields above don't name still trips the gate.

### Pending debt

When one side is ahead of the other, the map says so instead of pretending:

- `"figma": null, "pending": "what Figma owes"`: the code exists and the Library doesn't have it yet.
- `"code": { …, "pending": "what code owes" }`: the Library has it and code hasn't built it yet.

`check` reports every debt as a **warning on every run**. A refresh pays off a
`figma: null` debt automatically, and only by **exact name match**.

### Waivers

A blocking divergence can be accepted on the record with a line in the commit
message:

```
Design-drift: Button, Badge — re-padded to the 4px grid; code already matches
```

---

## Commands

| Command | Does | Exit codes |
|---|---|---|
| `init` | Guided setup (nine steps, see Quick start). Flags for unattended use: `--yes`, `--adapter css-tailwind4\|swift`, `--library <url\|key>`, `--product <url\|key>`, `--seed` / `--no-seed`, `--no-token`, `--no-hooks`, `--force`. Idempotent; never overwrites without `--force`. | 0; 2 on a bad flag |
| `status [--json]` | Where the project stands (`code-first`, `unseeded`, `design-first`, `in-step`, `diverged`, `in-sync`) and the next step. `--json` for agents and scripts. | 0; 1 when diverged |
| `tokens` | Regenerate the token file. | 0, or 1 if the adapter reported errors |
| `tokens --check` | Compare the committed generated file with what would be generated. | 0 fresh; 1 stale or errors |
| `check [--json]` | Offline: tokens fresh; map entries point at real files and exports; the map and snapshot agree both ways (values included); icons pair up; debts reported. | 0 clean (warnings allowed); 1 any error |
| `snapshot` | Read the published Library over REST and rewrite the snapshot. Pays off `figma: null` debts by name. | 0; 2 on a network, auth or config failure |
| `snapshot --check` | Report how the published Library differs from the snapshot. Never writes. | 0, always (warn only) |
| `snapshot --check --block` | As above, but exit 1 when a **breaking** change hits a component the code **calls** and no waiver names it. | 0; 1 blocked; 2 failure |
| `… --soft` | No token, no `fileKey` or no network → say so and exit 0. **HTTP errors (403, 404) still fail.** | |
| `… --message-file F` | Read the waiver from the commit message being written, not from `HEAD`. | |
| `hooks` | `git config core.hooksPath scripts/githooks`, and the executable bit on both hooks in the index | 0; 2 outside a git repo |

Exit code 2 always means "couldn't run", never "found drift".

---

## The gates: what they reject, and why

Every rejection is meant to say *what* moved and *what to do*. These are the
rules, and why they're the rules.

### `tokens --check`: "`<file>` is stale"

**Rejects:** the committed generated file differs from what the source would generate.

**Why:** a generated file that's also committed is a drift trap. Someone edits the source and forgets to regenerate, and the committed copy silently describes the old design. Equally bad, someone edits the generated file by hand, and the next regeneration erases their change. A byte comparison catches both. The generated file embeds the source's sha256 so a reviewer can see what it came from.

**Note:** line endings are normalised before comparing and hashing, so a Windows checkout with `core.autocrlf=true` doesn't read as stale. (The original Python tooling did, on Windows.)

### `check`: map integrity

| Rejection | Why |
|---|---|
| `code.file does not exist` / `<Symbol> is not exported from <file>` | A map entry pointing at nothing makes every downstream answer wrong, including the gate's count of call sites. Mark it `code.pending` if it's genuinely not built yet. |
| `Figma component "X" is also claimed by Y` | Two code components can't both be the implementation of one Figma component; one of them is lying. |
| `figma is null with no pending note` | A `null` with no explanation is invisible debt. The note forces someone to say what Figma owes, and it's repeated on every run until paid. |
| *(warning)* `awaits a Figma component — …` / `awaits its code — …` | Debt is reported, not blocked. Being one side ahead is normal; *forgetting* that you are isn't. |

### `check`: the code roster (when your test runner supplies it)

| Rejection | Why |
|---|---|
| `X is a code component with no map entry` | A new component can't slip into code without the Library learning about it. This is the gate that forces "add it to Figma" into the same PR. |
| `variant="ghost" exists in code but no Variant value maps to it` | Code supports a variant the Library can't express, so designers will never use it, or will draw it by hand. |
| `Variant maps to variant="x", which Button does not accept` | The Library offers something code can't render. |
| `X is not in the code roster` | A map entry for a component that isn't in your roster. Mark it `"composite": true` if it's deliberately built from roster parts. |

Both directions are checked against **the same arrays your code exports**
(`BUTTON_VARIANTS`, …), so an enumeration is never typed a second time.

### `check`: map ↔ snapshot, both directions

| Rejection | Why |
|---|---|
| `Figma component has no entry in the map` | Something published in the Library has no pairing in code. Either code is missing it, or it shouldn't be in the Library. |
| `<Axis>=<value> is not mapped (add a value or mark it nonApi)` | Every variant a designer can pick must mean something in code. `{ "nonApi": true }` is the explicit escape hatch for Figma-only states such as `Hover` previews. |
| `<TYPE> property "X" has no home in the map` | An exposed Figma property that code doesn't take is a knob that silently does nothing in the implementation. |
| `declares "X" but <component> has no such property in the snapshot` | The map promises a property Figma doesn't have. Mark it `"figma": false` if it's code-only by design. |
| `maps <Axis>=<value> but <component> has no such value in the snapshot` | The reverse of "not mapped": the map (and so the code) relies on a variant Figma never published. |
| `… — did you mean "Button"? Names must match exactly` | A near miss (`button`, `Primary Button`) is the usual half-synced state. The hint names the candidate; the rule stays exact. |
| `no Icon/x in the snapshot` / `Icon/x has no entry in the icons table` | Icons are paired like components, by name, both ways. |

### `snapshot --check`: the published Library moved

This is the gate with the most judgement built in. When the published Library
differs from the snapshot, every divergence is classified:

| | Code calls it (≥ 1 use) | Nothing calls it |
|---|---|---|
| **Additive** (new component, new variant, new property — every existing variant byte-identical) | advisory | advisory |
| **Breaking** (removed; variant or property taken away or retyped; any change inside an existing variant) | **blocks** (with `--block`) | advisory |

**Why "breaking only when called":** a component nobody calls can't break the
product, however much it changed in Figma. One with call sites has already
changed the product's shape. The gate decides that from **evidence**, by
counting call sites, rather than from anyone's assertion, because the assertion
is the part that goes stale. An earlier version counted instances in the Figma
Product file instead. That answers whether the *drawings* use a component, not
whether the *product* does.

**Why additive changes don't block:** adding a variant or property leaves every
existing call site working. They're still reported. And the moment you refresh
the snapshot, `check` will reject any new variant value the map doesn't cover.
So additive changes are caught *at the right time*: when you pull them in, not
when someone else publishes them.

**Why padding and stroke changes count as breaking:** they change what a
consumer's layout has to compensate for, and they're the most common real
change to a component. A designer re-padding a button is precisely the change
that ships unnoticed.

**Why a rename blocks:** Figma identifies components by node, but this contract
identifies them by **name**. A rename is a removal plus an addition, and
removing a component the code calls is breaking. That's deliberate: renames are
rare, and silently following one would break the name-identity rule everywhere
else.

**Why the commit hook warns but CI blocks:** a commit is a checkpoint; a push is
a publication. A divergence found mid-change is usually one you're in the middle
of making, so blocking every commit would just teach people `--no-verify`. CI is
where it has to be resolved.

### Waivers: `Design-drift: <Name>, … — reason`

| Rule | Why |
|---|---|
| The line must **name** every blocking component (case-insensitive, whole word) | The first version accepted any `Design-drift:` line, and it immediately waved through a real divergence in a commit whose message was *explaining the waiver mechanism*. Naming forces the author to look at each one. |
| `IconButton` does not waive `Button` | Whole-word matching, so a similar name can't waive a different component by accident. |
| Partial waivers still block, and say which components aren't covered | Waiving three components shouldn't quietly waive a fourth. |
| The reason stays in git history | Next to the change it waved through, where the next person will look. |

**Caveat:** in CI the waiver is read from `HEAD`'s commit message. On a pull
request the workflow checks out the PR's head commit (not GitHub's merge
commit), so the waiver must be in the **last commit of the PR**. A waiver in an
earlier commit isn't seen. Squash-merge flows are fine, as long as the squash
message keeps the line.

### `--soft`

`--soft` exists for the commit hook and for local gates. A missing token, a
missing `fileKey` or no network shouldn't stop you committing on a plane. It
does **not** swallow HTTP errors: a 403 means your token is wrong or lacks a
scope, and that should be loud. **Don't use `--soft` in CI.** There, a skipped
check would look like a passing one, so the workflow template skips the step
explicitly, with a visible `::warning`, when the secret isn't set.

### Why `check` isn't in your build

`tokens --check` belongs in the build, because it's purely about code.
`check` and `snapshot` compare code against Figma, and **a Figma change must
never break a code build**: a designer publishing the Library at 5pm shouldn't
turn every engineer's local build red. They run in pre-commit, in CI and in
your test suite, where the failure is attributable and the fix is a choice.

### What isn't gated, on purpose

- **Raw values in your UI code** (a hex in a view, a raw font size). Your own linter owns that. Two linters with overlapping rules disagree, and the disagreement becomes its own drift.
- **Visual pixel diffs.** The fingerprint is structural. A changed glyph, a new image fill or a different shadow colour still changes `hash`, but no structural check will say *how* it looks. Pair this with screenshot review.
- **Unpublished Figma work.** It's invisible to the gate by design. Work in progress can't raise false alarms, and only what consumers can actually receive is compared.

---

## Configuration reference

`figma-sync.config.js` sits at the repo root. Commands find it by walking up from the current directory.

```js
module.exports = {
  // root: '.',                       // optional; paths below are relative to it

  tokens: {
    adapter: 'css-tailwind4',         // 'css-tailwind4' | 'swift' | './path/to/your-adapter.js'
    source: 'src/index.css',          // the truth
    out: 'design/tokens.json',        // what is generated
    options: { /* adapter-specific, see Adapters */ },
  },

  paths: {
    map: 'design/component-map.json',
    snapshot: 'design/figma-components.json',
  },

  code: {
    // A map entry's symbol (or code.export) must match one of these in code.file.
    // {sym} is replaced with the escaped symbol. Either one pattern…
    declPattern: String.raw`export\s+(?:default\s+)?(?:const|function|class)\s+{sym}\b|export\s*\{[^}]*\b{sym}\b`,
    // …or one per entry `kind`, with an optional `default`:
    // declPatterns: { view: String.raw`^\s*struct\s+{sym}\b`, default: … },
  },

  usage: {                            // how call sites are counted for the snapshot gate
    roots: ['src'],
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    ignore: ['__tests__', 'stories'], // directory names to skip, anywhere in the tree
    pattern: String.raw`<{sym}[\s/>.]`,     // each match is one use
    // declPattern: String.raw`^\s*struct\s+{sym}\b`, // optional; matches are subtracted
  },
};
```

## Component map reference

```jsonc
{
  "components": [
    {
      "id": "Button",                                   // stable id for messages; usually the symbol
      "figma": { "component": "Button" },               // or { "components": ["A", "B"] }, or null + "pending"
      "pending": "what Figma owes",                     // only with figma: null
      "code": {
        "symbol": "Button",                             // = the Figma name (name identity)
        "export": "ButtonRoot",                         // only if the export binding differs
        "file": "src/components/ui/button.tsx",
        "kind": "component",                            // selects code.declPatterns[kind]
        "pending": "what code owes"                     // design-first: Library has it, code doesn't yet
      },
      "composite": false,                               // true = deliberately not in the code roster
      "axes": {
        "Variant": {
          "prop": "variant",                            // ties the axis to a prop the roster can verify
          "values": {
            "default": "default",                       // Figma value → code value
            "Hover": { "nonApi": true }                 // Figma-only preview state
          }
        }
      },
      "properties": {
        "Label": { "type": "TEXT", "code": "children" },                // Figma property → where it lands in code; `type` is informational
        "Badge": { "code": "badge", "figma": false }    // code-only: not expected in Figma
      },
      "slots": { "Content": { "accepts": ["Item"] } },
      "allowRaw": ["rounded-full: 9999"],               // raw values the audit should accept
      "notes": "free text"
    }
  ],
  "icons": {
    "figma": { "prefix": "Icon/" },                     // one component per icon (recommended)…
    // "figma": { "component": "Icon", "axis": "Name" }, // …or one set with a Name axis
    "values": { "plus": "plus", "close": "xmark" }      // Figma icon name → code icon key
  }
}
```

Maps written for the original Swift tooling use `"swift": { … }` instead of
`"code": { … }`. Both are read identically, including `swift.pending`.

## Snapshot reference

```jsonc
{
  "fileKey": "…",            // the published Library: required for `snapshot`
  "productFileKey": "…",     // informational; the Product file isn't gated
  "hashVersion": "js2",      // fingerprint format, written by `snapshot`
  "capturedAt": "2026-…",
  "pages": {}, "productScreens": {},   // free-form, preserved across refreshes
  "components": [
    {
      "name": "Button", "key": "…", "nodeId": "8:326", "type": "COMPONENT_SET",
      "updatedAt": "…", "page": "Buttons",
      "axes": { "Variant": ["default", "outline"] },
      "properties": { "Label": "TEXT", "Icon": "INSTANCE_SWAP" },
      "shape": { "variants": { "Variant=default, Size=default": { "pad": [0, 12, 0, 12], "gap": 6, "strokes": {}, "unbound": 0, "hash": "…" }, "…": {} }, "unbound": 0, "hash": "…" },   // a standalone COMPONENT has pad/gap/strokes at the top level instead
      "variables": "…", "note": "…"   // agent-written; a refresh never drops them
    }
  ]
}
```

---

## The Claude Code plugin

The plugin has two skills, invoked as `/figma-code-sync:<skill>` or picked up automatically:

- **`design-audit`** compares the live Library with your files through the Figma MCP. It covers the part REST can't see: **variable values in every mode**, **unbound raw values inside components**, and the inventory. It ends with `DRIFT: <mismatches> / <unbound> / <component changes>`. It also handles "push the token change to Figma", "pull token drift from Figma" and "refresh the snapshot".
- **`figma-workflow`** covers the three workflows:
  - **A (Figma → code):** implement a frame from Library instances, and stop to ask instead of guessing.
  - **B (code → Figma):** edit the Library component itself, never instances, and only **after** the code change is committed.
  - **C (tokens, either direction).**

  It also carries the definition of done and the Plugin API lessons below.

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

## Adapters

| Adapter | Mode | Reads | Writes |
|---|---|---|---|
| `css-tailwind4` | extract | a Tailwind v4 / shadcn stylesheet | `design/tokens.json` |
| `swift` | emit | `design/tokens.json` | a SwiftUI theme file |

### `css-tailwind4`

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

### `swift`

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

### Writing your own

An adapter is a module that exports one of these, and `tokens.adapter: './my-adapter.js'` loads it:

```js
// extract mode: platform → tokens
exports.read = ({ source, options }) => ({ tree, modes, errors });  // tree = { color: {…}, radius: {…}, … }

// emit mode: tokens → platform
exports.render = (tokens, { sha256, options }) => '…file contents…';
exports.parse = (text) => tokens;  // optional; use it if key order matters
```

---

## Caveats and known limitations

These are honest limitations. Several are Figma's, some are ours.

### Figma

- **Variable values aren't on the REST API below Enterprise.** The snapshot sees components, axes, properties and structure, but not what `color/primary` is set to. Only the `design-audit` skill (through the Figma MCP) compares variable values. **Token drift in Figma isn't caught by CI.** Run the audit before every publish.
- **Only the published Library is visible.** A changed but unpublished component looks unchanged. That's intended (see above), but it means the gate reports what consumers can receive, not what's on the designer's canvas.
- **The Product file isn't gated.** Screens drift from code without any check; the contract only covers the Library. Keep screens built from Library instances, and treat them as illustrations.
- **Publishing is manual, and so is accepting it.** Every Library change needs a human click before anything downstream sees it, and a consuming file keeps stale copies of the components until the update is accepted there too; the `figma-workflow` skill refreshes instances by re-importing their component keys.
- **Plugin API quirks** (they matter if you, or Claude, build components programmatically):
  - Assigning a variable-bound paint can reset its `opacity` to 1. Bind, assign, then reassign a copy with the opacity.
  - Instances can render bound paints at full opacity regardless. Put translucency on the layer: node opacity, or a locked full-size "wash" rectangle.
  - `createFrame()` clips content by default, which shaves shadows. Set `clipsContent = false`.
  - Binding a variable on a nested instance creates an override, even when the value matches the main component. Bind on instances only what they genuinely override.
  - Component descriptions escape `<`, `>` and `"` on write. Keep them out of the `Code:` line.
  - `fetch` isn't available inside `use_figma` scripts. Bulk SVGs (icons) go in through the MCP's `upload_assets`.
- **Per-mode values on a single paint aren't possible.** A component whose code uses a `dark:` override with a different role, or different opacity, can only be drawn with one of them. Bind to roles that resolve per mode instead, so the variable modes do the work.
- **Interaction states** (hover, focus, pressed, disabled) usually aren't drawn as variants in a code-first library, and so aren't gated. If you draw them, map them as `{ "nonApi": true }`.

### This package

- **Call sites are counted with a regex**, not a parser. It counts matches in comments and strings too, and a `pattern` that's too loose (`\bButton\b` also matches `</Button>`) over-counts. Over-counting errs towards blocking, which is the safe direction. Under-counting (a component only used through a re-export alias, or via `React.createElement`) makes a breaking change look advisory. Check your pattern against your codebase.
- **Declarations are matched with a regex too** (`code.declPattern`). Unusual export forms need a pattern that covers them.
- **The map is hand-maintained.** There's no generator; seed it from your own component metadata (Tripeaz does this once from its test runner). The roster check keeps it honest afterwards, but only if your test runner supplies a roster.
- **`check` verifies the Figma side of `properties`, not the code side.** It knows the Figma property `Label` exists and has a home in the map, but not that `children` is really what `Button` renders it from.
- **`css-tailwind4` limits:**
  - **Not resolved:** `hsl()`, `color-mix()`, `lab()`/`lch()`, relative colour syntax, and `calc()` beyond `var(--x) * k`. Any of these in a role is an **error**, not a guess. (shadcn's older Tailwind v3 themes, which store bare `222 84% 5%` HSL triplets, aren't supported.)
  - **Modes by selector only:** modes come from block selectors, not `@media (prefers-color-scheme)` queries. A theme that switches dark mode with a media query instead of a class/selector needs a custom `modes` setup, and may not be expressible.
  - **One stylesheet:** a single stylesheet is read; `@import`ed files aren't followed.
  - **Not tokenised:** shadows (they're Figma effect *styles*, written by Claude from your elevation scale), gradients and motion. Spacing *is*, but only once you declare `--spacing` and list the steps you use. Arbitrary values in code (`p-[3px]`) stay raw by definition; list them in `allowRaw`.
  - **Key order in `tokens.json`:** JSON objects put integer-like keys first, so `spacing` lists `1, 2, 3 … 24` before `0-5, 1-5 …`. Nothing that reads the file depends on the order, and the output is deterministic.
  - **Light-first output:** the first mode is `$value`, and other modes go in `$extensions.modes`. That's a convention, not DTCG standard; DTCG has no multi-mode value yet.
- **`swift` limits:** one mode only (no light/dark per token), four font weights (`regular`, `medium`, `semibold`, `bold`), and semantic colours exactly three levels deep. These are the original generator's rules, kept for byte-compatibility.
- **oklch rounding:** a hex converted to oklch and back can land one 8-bit step away (`#d97706` → `#d97708`). The audit allows ±1 per channel when the source is oklch.
- **A snapshot entry without a fingerprint** (written by hand, by the audit skill's no-token fallback, or by the original Python tool) is compared without it until the next plain `snapshot` fills it in; padding, gap, strokes and the unbound count still gate. **The first `snapshot --check` after migrating from another tool** likewise compares without fingerprints. The hashes aren't comparable across implementations, so padding, gap, strokes and the unbound count still gate, but "internals changed" can't be detected until you run one plain `snapshot` to rewrite them.
- **`--soft` hides network failures** from the hook and local gates. That's by design, but a misconfigured machine can skip the Library check for a long time without anyone noticing. CI shouldn't use it.
- **Hooks are POSIX `sh`.** They work in Git for Windows and in any Unix shell, not in plain `cmd.exe`. The pre-commit hook's path filter is deliberately narrow (`design/`, the config). Widen it to your token source and component directories.
- **Hooks need the executable bit, and Windows can't set it on disk.** Git silently skips a hook that isn't executable, so a hook committed from Windows would do nothing on a macOS or Linux clone. `figma-code-sync hooks` marks both hooks executable in the git index (`git update-index --chmod=+x`) once they're tracked; run it again after the first commit that adds them, or check with `git ls-files -s scripts/githooks` (mode should be `100755`).
- **Not on the npm registry yet.** Install from GitHub and pin a tag. `npx github:…` in CI clones on every run; a devDependency is faster. In a non-Node repo (Swift), add `node_modules/` to `.gitignore`.
- **Not supported yet:** Code Connect (it would complement the map, not replace it), Android/Compose and Flutter adapters, multi-brand modes beyond light/dark, and the Product file.

## Migrating from the original Python scripts

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
5. Run one plain `npx figma-code-sync snapshot` to rewrite fingerprints in this format (see [Caveats](#this-package)).
6. Point your hooks and CI at the new commands, then delete the old scripts.

## FAQ

**Why not Code Connect?** It's an Organization/Enterprise feature, and it maps
components to *snippets*. This maps them to a *contract* that is checked in
both directions. The two could coexist.

**Why not Tokens Studio?** It's a fine way to *author* tokens in Figma. This is
about *gating* drift between whatever the truth is and both sides.

**Can Figma be the token truth?** Not directly yet. The `design-audit` skill's
"pull token drift" writes Figma's values back into your truth file, so Figma
can *originate* a change, but the repo stays canonical. Icons can be
Figma-owned: Seesay draws its icons in Figma and generates the code from them.
That pipeline isn't packaged yet.

**Does Claude have to be involved?** No. The CLI, the hooks and CI work alone.
Claude (or a person with the Figma plugin API) is only needed to *write* to
Figma and to audit variable values.

**Is my Figma token safe?** It's read only from `FIGMA_TOKEN` or `~/.figma-token`,
sent only to `api.figma.com` as `X-Figma-Token`, and needs only read scopes.
Never commit it.

## License

MIT © Jason Chan
