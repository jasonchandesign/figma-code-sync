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

> **Status: 0.1.** The system has run in three production projects: two SwiftUI apps (Math Sheets Unlimited, Seesay Lingo) and a React + Tailwind v4 + shadcn/ui web app (Tripeaz). This package extracts it. The code is tested; the packaging is new. Read [Caveats](docs/caveats.md) before relying on it.

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
behind each gate is spelled out in [The gates](docs/gates.md),
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

1. **Publish it in Figma.** That stays a human click; see [why](docs/plugin.md#why-is-publishing-manual).
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

## Documentation

| Read | For |
|---|---|
| [Concepts](docs/concepts.md) | Truth modes, what becomes a Figma variable, name identity, the map, the snapshot fingerprint, pending debt, waivers |
| [The gates](docs/gates.md) | Every rejection each gate produces, and why it is a rule |
| [Reference](docs/reference.md) | `figma-sync.config.js`, `component-map.json` and `figma-components.json`, field by field |
| [The Claude Code plugin](docs/plugin.md) | The `design-audit` and `figma-workflow` skills, the Library build kit, and the programmatic API for your test runner |
| [Adapters](docs/adapters.md) | `css-tailwind4`, `swift`, and writing your own |
| [Caveats](docs/caveats.md) | What Figma cannot show, what this package does not check, Plugin API quirks |
| [Migrating](docs/migrating.md) | From the original Python scripts |
| [FAQ](docs/faq.md) | Code Connect, Tokens Studio, Figma as truth, whether Claude is required |

For AI agents: [`AGENTS.md`](AGENTS.md) is the step-by-step setup procedure and [`llms.txt`](llms.txt) indexes everything above.

## License

MIT © Jason Chan
