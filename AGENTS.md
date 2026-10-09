# figma-code-sync — setup protocol for AI agents

This file is for an AI agent (Claude Code, ChatGPT, Cursor, or similar) asked to
set figma-code-sync up in a project. Every step is one command with a check you
can verify from its output or exit code. Nothing here needs a human at the
keyboard except two things the tool cannot do: paste a Figma token, and press
**Publish** in Figma.

## What you are setting up

- `figma-sync.config.js` — where the token source, the components and the call sites live
- `design/tokens.json` — generated from the token source (web) or hand-edited (Swift)
- `design/component-map.json` — Figma ↔ code pairings, one entry per component
- `design/figma-components.json` — the published Library, as last read over REST
- git hooks + a CI workflow that fail when the two sides disagree

Read `README.md` for the reasoning. This file is only the procedure.

## Step 0 — install (once)

```sh
npm i -D github:jasonchandesign/figma-code-sync#v0.1.0
```

Check: `npx figma-code-sync --help` prints the command list (exit 0).

## Step 1 — guided init

Interactive (a person at the terminal):

```sh
npx figma-code-sync init
```

Non-interactive (you, the agent — pass what you know, skip the rest):

```sh
npx figma-code-sync init --yes [--adapter css-tailwind4|swift] [--library <figma url or key>] [--product <url or key>] [--seed|--no-seed] [--no-token]
```

`init` is idempotent: re-run it any time to resume, it never overwrites a file
you edited (unless `--force`). It runs nine steps and prints each one:

| Step | What it does | What you check in the output |
|---|---|---|
| 1 detect | picks the adapter (a Tailwind v4 stylesheet → `css-tailwind4`; an Xcode project → `swift`) | the adapter named is right; otherwise pass `--adapter` |
| 2 scaffold | writes the files above | `created`/`kept` per file |
| 3 token | finds `FIGMA_TOKEN` or `~/.figma-token`, or prompts (hidden) | `found` or `saved`. **If `skipped`: ask the person to create a token** (Figma → Settings → Security → Personal access tokens, scopes `file_content:read` + `library_content:read`) and save it to `~/.figma-token`. Never put it in the repo, never echo it. |
| 4 library | records the Library file key, verifies access | `verified: "<file name>"`. `cannot verify: …` tells you which of token/key is wrong |
| 5 tokens | generates `design/tokens.json` (web) or the platform file (Swift) | the counts line; for web, **a spacing count > 0** (if 0, add `@theme { --spacing: 0.25rem; }` to the stylesheet and re-run) |
| 6 snapshot | reads the published Library | `wrote design/figma-components.json (N components)`, or `skipped` with the reason |
| 7 seed | design-first only: offers map entries for every published component | `seeded N entries` or `nothing to seed` |
| 8 hooks | enables the git hooks | needs `.git`; otherwise run `npx figma-code-sync hooks` after `git init` |
| 9 status | classifies the project | see Step 2 |

## Step 2 — read the state, do the next thing

```sh
npx figma-code-sync status --json
```

Returns `{ state, next, token, fileKey, published, entries, awaitingFigma, awaitingCode, tokensFresh, ok, errors: [{where, message}], warnings: [...] }`.
Exit 1 means `state` is `diverged`.

| `state` | Meaning | What to do |
|---|---|---|
| `code-first` | no Library connected, or nothing published yet | build the Library from `design/tokens.json` and the components (Claude Code: the `figma-code-sync:figma-workflow` skill, "Building the Library"); ask the person to **Publish**; then `init --library <url>` |
| `unseeded` | Library published, map empty | `init --seed` (design-first) or write map entries for the code components (see the map shape in README → "Component map reference") |
| `design-first` | map entries exist in Figma, not in code | build each component in code; set its `code.file`; remove `code.pending` |
| `in-step` | both sides exist, some entries still owed | draw / build the owed ones; publish; `npx figma-code-sync snapshot` pays off Figma-side debt by name |
| `diverged` | `errors` is non-empty | each error names the file, the component and the side that moved; fix that side (names must match exactly; a value in Figma that isn't in code, or the reverse, is listed by name) |
| `in-sync` | nothing owed, nothing disagreeing | done; keep the gates running |

Loop on Step 2 until `in-sync`. Run `npx figma-code-sync check --json` for the
findings alone.

## Step 3 — wire the code side's roster (web projects with a test runner)

The CLI cannot evaluate JSX, so it cannot know which variants a React component
accepts. Add a test that hands it the roster (README → "Using it from your own
test runner"). After that, `npm test` also fails when code grows a component or
a variant that the map (and so Figma) doesn't know.

## Rules you must not work around

- Never edit `design/tokens.json` in extract mode (web): it is generated. Edit the stylesheet and run `npx figma-code-sync tokens`.
- Never create components in the Product file; never detach instances. Screens are instances of published Library components.
- Never commit the token. Never pass it on a command line.
- A gate that blocks is reporting a real disagreement. The waiver (`Design-drift: <Name> — reason` in the commit message) is for a person who has looked, not for an agent to pass CI.
- Publishing the Library is a human click. Ask for it; do not claim it happened.

## Writing to Figma

Only through Figma's MCP server / plugin API. In Claude Code, install the plugin
(`/plugin marketplace add jasonchandesign/figma-code-sync`, then
`/plugin install figma-code-sync@figma-code-sync`) and use the
`figma-workflow` skill to build the Library and the `design-audit` skill to
compare variable values. Other agents: follow `plugin/skills/figma-workflow/SKILL.md`
and prepend `plugin/skills/figma-workflow/references/kit.js` to each script.
