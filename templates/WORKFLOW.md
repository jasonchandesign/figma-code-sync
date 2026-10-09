# Figma ↔ code: how the two stay one design

The UI exists twice: as code, and as a component library in Figma. This
document is the contract that keeps them the same thing in both directions, and
lists where drift gets caught. The engine is
[figma-code-sync](https://github.com/jasonchandesign/figma-code-sync). Edit this file
to record your project's own decisions.

## 1. The system in one paragraph

The token source of truth is `<tokens.source in figma-sync.config.js>`. It is
one of two things:
- **emit mode:** `design/tokens.json` is hand-edited, and the platform file is generated from it;
- **extract mode:** a stylesheet is the truth, and `design/tokens.json` is generated from it.

Either way, Figma's variables are written from `design/tokens.json` by Claude
over the Figma MCP. Components are matched by **name identity**: the Figma
component is called what the code symbol is called. `design/component-map.json`
carries what a name can't.

Drift is caught in four places:
- the offline `check`, which runs in pre-commit and CI;
- a commit-msg warning against the published Library;
- a blocking CI check against the published Library;
- a manual `/design-audit`.

## 2. Source of truth, per layer

| Layer | Truth | Sync |
|---|---|---|
| Tokens | `<token source>` | `npx figma-code-sync tokens`; Claude writes Figma variables |
| Icons | `<code or Figma — decide>` | one `Icon/<name>` component per icon; the map's `icons` table pairs names |
| Components | code *and* Figma, matched by name | name identity + `component-map.json` |
| Screens | code once built; until then the Product file | manual, Workflow A or B |

## 3. Decisions

| # | Decision |
|---|---|
| D1 | Token truth is `<…>`. A change that starts in Figma comes back as an edit to it. |
| D2 | Two Figma files. **Library** is published and is the only place components, variables and styles are defined. **Product** subscribes and holds screens only. The keys are in `design/figma-components.json`. |
| D3 | Figma component name = code symbol. Any exception is recorded in the map. |
| D4 | Variant axes are the code's enumerations, title-cased; their values are the code's exact strings. |
| D5 | Every component description starts `Code: <Symbol> — <path>`. |

## 4. Artifacts and who writes them

| Path | Written by |
|---|---|
| token source | you, or Claude from a Figma diff |
| generated token or platform file | `npx figma-code-sync tokens` only |
| `design/component-map.json` | you or Claude, with any component change |
| `design/figma-components.json` | `npx figma-code-sync snapshot`, or Claude ("refresh the snapshot") |

## 5–7. Workflows A, B, C

These are the `figma-workflow` skill's workflows (install the Claude Code
plugin: `/plugin marketplace add jasonchandesign/figma-code-sync`):
- **A:** implement a Figma frame in code;
- **B:** reflect a committed code change into the Library or Product file;
- **C:** move a token change in either direction.

## 8. Definition of done (any component change)

- [ ] The Figma name equals the code symbol, or the map records the pairing.
- [ ] Every value is bound to a variable or style, or listed in `allowRaw`.
- [ ] The `Code:` description line is current.
- [ ] The map entry is current: axes, properties, slots, `pending`.
- [ ] The snapshot has been refreshed.
- [ ] `npx figma-code-sync check` passes.
- [ ] The Library is published and the Product file has accepted the update.

## 9. Where drift is caught

| Check | Catches | Runs |
|---|---|---|
| `tokens --check` | Generated file stale against its source. | build / test |
| `check` | Map entry pointing at a missing file or export; a Figma component with no map entry, or the reverse; an unmapped variant value or property; icon table vs snapshot; pending debts (warnings). | pre-commit, CI |
| `snapshot --check [--block]` | The published Library moved: a component added or removed, an axis or property changed, padding, gap, stroke or unbound count changed. It blocks only when a breaking change hits a component the code calls. Waive it with `Design-drift: <Name> — reason`. | commit-msg (warns), CI (blocks) |
| `/design-audit` | Variable values, raw values inside components, inventory. | before every publish |

## 10. Setup (once per clone)

- `npx figma-code-sync hooks`
- Put a Figma personal access token with `file_content:read` and `library_content:read` in `~/.figma-token`. Never put it in the repo. CI reads the `FIGMA_TOKEN` secret.
